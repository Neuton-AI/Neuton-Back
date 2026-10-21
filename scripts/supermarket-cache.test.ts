import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createCatalogCache, CATALOG_TTL_MS } from '../src/lib/supermarket/catalog-cache.js';
import { CATALOG_RETRY_DELAY_MS, createProductSearch, parseXmlItems } from '../src/lib/supermarket/prices.js';

const xml = '<Root><Items><Item><ItemCode>123</ItemCode><ItemName>Milk</ItemName><ItemPrice>7.5</ItemPrice></Item></Items></Root>';

test('sequential ingredient searches skip an unavailable chain until cooldown expires', async (t) => {
  let time = 1_800_000_000_000;
  let offline = true;
  let failedChainCalls = 0;
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const search = createProductSearch(async chain => {
    if (chain === 'shufersal') {
      failedChainCalls++;
      if (offline) throw new Error('request timed out');
    }
    return parseXmlItems(xml);
  }, () => time);
  for (const query of ['Milk', '123', 'missing', 'Milk']) {
    const results = await search(query);
    assert.ok(results.every(item => item.chain === 'carrefour'));
    if (query !== 'missing') assert.equal(results.length, 1);
  }
  assert.equal(failedChainCalls, 1);
  assert.equal(errors.length, 1);
  time += CATALOG_RETRY_DELAY_MS - 1;
  await search('Milk');
  assert.equal(failedChainCalls, 1);
  offline = false;
  time++;
  assert.equal((await search('Milk')).length, 2);
  assert.equal(failedChainCalls, 2);
  assert.equal(errors.length, 1);
});

async function fixture(t: TestContext) {
  await mkdir('Temp', { recursive: true });
  const directory = await mkdtemp(resolve('Temp/catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 1_800_000_000_000;
  let downloads = 0;
  let parses = 0;
  let failure = false;
  const options = {
    directory, now: () => time,
    download: async () => { downloads++; if (failure) throw new Error('network offline'); return xml; },
    parse: (value: string) => { parses++; return parseXmlItems(value); },
  };
  return { directory, options, cache: createCatalogCache(options),
    advance: (ms: number) => { time += ms; }, fail: (value: boolean) => { failure = value; },
    counts: () => ({ downloads, parses }), time: () => time };
}

test('cold cache, parsed reuse, restart reuse, exact TTL and independent chains', async (t) => {
  const f = await fixture(t);
  const items = await f.cache.get('shufersal');
  assert.equal(items[0]?.ItemCode, '123');
  assert.equal(await readFile(join(f.directory, 'shufersal', `${f.time()}.xml`), 'utf8'), xml);
  f.advance(1);
  await f.cache.get('carrefour');
  assert.equal(await f.cache.get('shufersal'), items);
  assert.deepEqual(f.counts(), { downloads: 2, parses: 2 });
  await createCatalogCache(f.options).get('shufersal');
  assert.deepEqual(f.counts(), { downloads: 2, parses: 3 });
  f.advance(CATALOG_TTL_MS - 2);
  await f.cache.get('shufersal');
  assert.equal(f.counts().downloads, 2);
  f.advance(1);
  await f.cache.get('shufersal');
  await f.cache.get('carrefour');
  assert.equal(f.counts().downloads, 3);
  assert.deepEqual(await readdir(join(f.directory, 'shufersal')), [`${f.time()}.xml`]);
});

test('concurrent callers and independent cache instances share a completed download', async (t) => {
  const f = await fixture(t);
  const other = createCatalogCache(f.options);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? f.cache : other).get('shufersal')));
  assert.equal(f.counts().downloads, 1);
  for (const result of results) assert.deepEqual(result, results[0]);
  f.advance(CATALOG_TTL_MS);
  await Promise.all([f.cache.get('shufersal'), other.get('shufersal')]);
  assert.equal(f.counts().downloads, 2);
});

test('corruption, invalid names, missing files, and download failure recover without stale results', async (t) => {
  const f = await fixture(t);
  await f.cache.get('shufersal');
  const folder = join(f.directory, 'shufersal');
  await writeFile(join(folder, `${f.time()}.xml`), '<Root><Item>broken');
  await writeFile(join(folder, 'invalid.xml'), xml);
  await writeFile(join(folder, 'abandoned.tmp'), '<Root>');
  await f.cache.get('shufersal');
  assert.equal(f.counts().downloads, 2);
  assert.equal((await readdir(folder)).length, 1);
  await rm(join(folder, `${f.time()}.xml`));
  await f.cache.get('shufersal');
  assert.equal(f.counts().downloads, 3);
  f.advance(CATALOG_TTL_MS);
  f.fail(true);
  await assert.rejects(f.cache.get('shufersal'), /shufersal.*network offline/);
  assert.deepEqual(await readdir(folder), []);
  f.fail(false);
  await f.cache.get('shufersal');
  assert.equal((await readdir(folder)).length, 1);
});

test('invalid downloaded XML never becomes a completed catalog', async (t) => {
  const f = await fixture(t);
  for (const invalid of ['<Root><Item></Root>', '<html>Access denied</html>']) {
    const cache = createCatalogCache({ ...f.options, download: async () => invalid });
    await assert.rejects(cache.get('shufersal'), /Invalid catalog|no price items/);
    assert.deepEqual(await readdir(join(f.directory, 'shufersal')), []);
  }
});

test('separate worker processes download once and reuse after process restart', async (t) => {
  const f = await fixture(t);
  const script = join(f.directory, 'worker.mjs');
  const moduleUrl = new URL('../src/lib/supermarket/catalog-cache.ts', import.meta.url).href;
  await writeFile(script, `import { createCatalogCache } from ${JSON.stringify(moduleUrl)};
import { appendFile } from 'node:fs/promises';
const cache = createCatalogCache({ directory: ${JSON.stringify(f.directory)},
download: async () => { await appendFile(${JSON.stringify(join(f.directory, 'downloads'))}, 'download\\n'); await new Promise(r => setTimeout(r, 150)); return ${JSON.stringify(xml)}; },
parse: () => [123] });
await cache.get('shufersal');`);
  const run = () => new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(error)));
  });
  await Promise.all([run(), run(), run()]);
  await run();
  assert.equal(await readFile(join(f.directory, 'downloads'), 'utf8'), 'download\n');
});

 test('search ranking, limits, receipt enrichment, and chain failure isolation stay intact', async (t) => {
  const { createProductSearch, enrichReciptItems } = await import('../src/lib/supermarket/prices.js');
  const { gzipSync } = await import('node:zlib');
  const { fetchXml } = await import('../src/lib/supermarket/client.js');
  const f = await fixture(t);
  let network = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    network++;
    return new Response(gzipSync(xml));
  });
  const cache = createCatalogCache({ ...f.options, download: () => fetchXml('https://fixture.invalid/catalog.gz') });
  const search = createProductSearch(chain => cache.get(chain));
  assert.equal((await search('123'))[0]?.score, 10000);
  assert.equal((await search('Milk', 1)).length, 2);
  assert.equal((await search('missing')).length, 0);
  assert.equal((await search('')).length, 0);
  const receipt = { items: [{ rawSku: '123', rawName: 'Milk', rawMaterialName: 'Milk' }] } as Parameters<typeof enrichReciptItems>[0];
  const cold = await enrichReciptItems(structuredClone(receipt), search);
  const warm = await enrichReciptItems(structuredClone(receipt), search);
  assert.deepEqual(warm, cold);
  assert.equal(warm[0]?.item.isSkuEnriched, true);
  assert.equal(network, 2);
  assert.equal(f.counts().parses, 2);
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const isolated = createProductSearch(async chain => {
    if (chain === 'shufersal') throw new Error('offline');
    return cache.get(chain);
  });
  assert.deepEqual((await isolated('123')).map(item => item.chain), ['carrefour']);
  assert.equal(errors.length, 1);
});

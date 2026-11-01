import assert from 'node:assert/strict';
import test from 'node:test';
import { createScrapySearch, ScrapyApiError } from '../src/lib/supermarket/scrapy-api.js';

const product = { chainId: 'rami-levy', itemCode: '00123', itemName: 'Milk',
  manufactureName: null, itemPrice: '6.0000', quantity: '1', unitQty: 'l', score: 9500 };

test('search sends explicit type and ten per chain, preserving camelCase rows and API order', async () => {
  const urls: URL[] = [];
  const search = createScrapySearch({ baseUrl: 'http://localhost:3000', fetch: async url => {
    urls.push(new URL(String(url)));
    return Response.json([product, { ...product, itemCode: '00456', score: 1 }]);
  } });
  const rows = await search('  חלב & milk  ');
  assert.deepEqual(rows, [product, { ...product, itemCode: '00456', score: 1 }]);
  await search('00123', 'sku');
  assert.equal(urls[0]?.pathname, '/v1/search');
  assert.equal(urls[0]?.searchParams.get('q'), 'חלב & milk');
  assert.equal(urls[0]?.searchParams.get('queryType'), 'name');
  assert.equal(urls[1]?.searchParams.get('q'), '00123');
  assert.equal(urls[1]?.searchParams.get('queryType'), 'sku');
  assert.ok(urls.every(url => url.searchParams.get('limitPerChain') === '10'));
});

test('empty input avoids HTTP and successful empty searches remain empty', async () => {
  let requests = 0;
  const search = createScrapySearch({ baseUrl: 'http://localhost:3000', fetch: async () => {
    requests++; return Response.json([]);
  } });
  assert.deepEqual(await search(' '), []);
  assert.equal(requests, 0);
  assert.deepEqual(await search('missing'), []);
  assert.equal(requests, 1);
});

test('nullable raw columns are retained while malformed responses fail explicitly', async () => {
  for (const body of [[{ ...product, itemName: null, itemPrice: null, quantity: null, unitQty: null }],
    [product], { items: [product] }, [{ ...product, score: '9500' }],
    [{ ...product, itemCode: 123 }], [{ ...product, itemPrice: 6 }]]) {
    const search = createScrapySearch({ baseUrl: 'http://localhost:3000', fetch: async () => Response.json(body) });
    if (Array.isArray(body) && (body[0] === product || body[0]?.itemName === null)) {
      assert.deepEqual(await search('Milk'), body);
    } else await assert.rejects(search('Milk'), { code: 'SUPERMARKET_UNAVAILABLE' });
  }
});

test('HTTP failures preserve diagnostics without masquerading as zero matches or retrying', async () => {
  for (const status of [400, 429, 503]) {
    let requests = 0;
    const search = createScrapySearch({ baseUrl: 'http://localhost:3000', fetch: async () => {
      requests++;
      return Response.json({ error: { code: 'UPSTREAM_ERROR', message: 'untrusted' } },
        { status, headers: { 'retry-after': '7', 'x-request-id': 'request-123' } });
    } });
    await assert.rejects(search('Milk'), (error: unknown) => {
      assert.ok(error instanceof ScrapyApiError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.retryAfterSeconds, 7);
      assert.equal(error.requestId, 'request-123');
      assert.equal(error.message.includes('untrusted'), false);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('timeouts bound both response headers and stalled bodies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stallBody of [false, true]) {
    const search = createScrapySearch({ baseUrl: 'http://localhost:3000', timeoutMs: 50,
      fetch: async (_url, init) => {
        if (stallBody) return new Response(new ReadableStream({ start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
        } }));
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      } });
    const rejected = assert.rejects(search('Milk'), { reason: 'timeout', statusCode: 503 });
    // Let the response body reader attach before advancing the clock.
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(50);
    await rejected;
  }
});

test('transport failures and invalid JSON are errors, and oversized queries never reach HTTP', async () => {
  for (const [fetch, reason] of [
    [async () => { throw new Error('connection refused'); }, 'network'],
    [async () => new Response('{broken'), 'response'],
  ] as const) {
    const search = createScrapySearch({ baseUrl: 'http://localhost:3000', fetch });
    await assert.rejects(search('Milk'), { reason, statusCode: 503 });
    await assert.rejects(search('x'.repeat(201)), { statusCode: 400 });
  }
});

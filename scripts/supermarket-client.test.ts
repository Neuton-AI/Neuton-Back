import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fetchText } from '../src/lib/supermarket/client.js';

const url = 'https://fixture.invalid/catalog.xml';

test('a timed out request retries and can recover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requests++;
    if (requests > 1) return new Response('<Root/>');
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    });
  });
  const result = fetchText(url);
  t.mock.timers.tick(30_000);
  assert.equal(await result, '<Root/>');
  assert.equal(requests, 2);
});

test('the deadline covers a stalled body and reports the URL after bounded retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    requests++;
    return new Response(new ReadableStream({
      start(controller) {
        options.signal!.addEventListener('abort', () => {
          controller.error(new DOMException('This operation was aborted', 'AbortError'));
        }, { once: true });
      },
    }));
  });
  const rejected = assert.rejects(fetchText(url), (error: Error) => {
    assert.match(error.message, /failed after 3 attempts/);
    assert.match(error.message, /timed out after 30000ms/);
    assert.ok(error.message.includes(url));
    return true;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await setImmediate();
    t.mock.timers.tick(30_000);
  }
  await rejected;
  assert.equal(requests, 3);
});

test('a body transport failure retries the entire download', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests > 1) return new Response('<Root/>');
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error('connection reset')); },
    }));
  });
  assert.equal(await fetchText(url), '<Root/>');
  assert.equal(requests, 2);
});

test('server errors release the response body before retrying; 404 is not retried', async (t) => {
  let requests = 0;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests > 1) return new Response('<Root/>');
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  });
  assert.equal(await fetchText(url), '<Root/>');
  assert.equal(requests, 2);
  assert.equal(cancelled, true);
  requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('', { status: 404 });
  });
  await assert.rejects(fetchText(url), /404/);
  assert.equal(requests, 1);
});

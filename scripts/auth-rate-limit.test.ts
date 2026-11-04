import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import type { AuthLimitStore } from '../src/modules/auth/rate-limit.service.js';

test('login failures share account limits across IPs; successful reservations do not count as failures', async () => {
  const counts = new Map<string, number>();
  const store: AuthLimitStore = {
    async increment(key, windowMs) {
      const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
      return { count, retryMs: windowMs, windowId: 'synthetic-window' };
    },
    async release(key) { counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1)); },
  };
  const limits = new AuthRateLimits(store, Buffer.alloc(32, 17), 'test:synthetic', 'neuton:auth:test:synthetic');
  for (let index = 0; index < 15; index += 1) {
    const attempt = await limits.beginLogin('192.0.2.1', 'alice@example.com');
    await limits.loginSucceeded(attempt);
  }
  for (let index = 0; index < 10; index += 1) await limits.beginLogin(`192.0.2.${index}`, 'alice@example.com');
  await assert.rejects(limits.beginLogin('192.0.2.99', 'alice@example.com'), { statusCode: 429 });
  assert.equal([...counts.keys()].some(key => /alice|192\.0/.test(key)), false);
  const production = new AuthRateLimits(store, Buffer.alloc(32, 17), 'production:synthetic', 'neuton:auth:production:synthetic');
  await production.beginLogin('192.0.2.1', 'alice@example.com');
  for (let index = 0; index < 3; index += 1) assert.equal(await limits.email('192.0.2.1', 'alice@example.com'), true);
  assert.equal(await limits.email('192.0.2.1', 'alice@example.com'), false);
});

test('limiter outages fail closed with a bounded 503 and no provider cause', async () => {
  const limits = new AuthRateLimits({ async increment() { throw new Error('private redis address'); }, async release() {} },
    Buffer.alloc(32, 17), 'test:synthetic', 'neuton:auth:test:synthetic');
  await assert.rejects(limits.beginLogin('192.0.2.1', 'alice@example.com'), {
    statusCode: 503, message: 'Authentication temporarily unavailable',
  });
});

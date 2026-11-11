import './support/testEnv.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Request } from 'express';

test('development accepts the default Vite loopback origins with no origin setting', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.APP_ORIGIN;
  const { requireOrigin, sessionSecret } = await import('../src/modules/identity/session-http.js');
  const request = (origin?: string) => ({ headers: { origin, cookie: 'neuton-session-local=fixture' } } as Request);
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    assert.doesNotThrow(() => requireOrigin(request(origin)));
    assert.equal(sessionSecret(request(origin)), 'fixture');
  }
  for (const origin of [undefined, 'null', 'http://localhost:5174', 'http://localhost.example:5173']) {
    assert.throws(() => requireOrigin(request(origin)), { statusCode: 403 });
  }
});

test('production uses APP_ORIGIN as the session origin', () => {
  const origin = 'https://app.example.test';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { sessionOrigins } from './src/modules/identity/session-http.ts';
    assert.deepEqual(sessionOrigins, [process.env.APP_ORIGIN]);
  `], {
    env: { ...process.env, NODE_ENV: 'production', APP_ORIGIN: origin },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
});

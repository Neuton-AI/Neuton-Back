import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthCookies } from '../src/modules/auth/cookies.js';
import { assertBrowserMutation, CsrfService } from '../src/modules/auth/csrf.service.js';
import { digestSecret, newSecret } from '../src/modules/auth/crypto.js';
import { isolatedAuthDatabase } from './support/authDatabase.js';

test('cookies are host-only and the local exception cannot apply to production', () => {
  const cookies = new AuthCookies({ origin: 'https://app.example', environment: 'production:synthetic', localHttp: false });
  const header = cookies.set('session', newSecret(), new Date(Date.now() + 60_000));
  for (const flag of ['__Host-neuton-session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(flag));
  assert.equal(header.includes('Domain='), false);
  const local = new AuthCookies({ origin: 'http://localhost:5173', environment: 'development:synthetic', localHttp: true });
  assert.ok(local.set('session', newSecret(), new Date(Date.now() + 60_000)).startsWith('neuton-dev-session='));
  assert.throws(() => new AuthCookies({ origin: 'http://localhost:5173', environment: 'production:synthetic', localHttp: true }));
  assert.equal(cookies.read('session', `__Host-neuton-session=${newSecret()}; __Host-neuton-session=${newSecret()}`), undefined);
});

test('CSRF rotation preserves browser binding and rejects stale or cross-session proof', async () => {
  const { database, auth } = await isolatedAuthDatabase();
  try {
    let sessionDigest = digestSecret('csrf', newSecret());
    const sessionSecret = newSecret();
    const csrf = new CsrfService(auth, {
      async csrfContext(secret) { return secret === sessionSecret ? { id: 'synthetic', csrfDigest: sessionDigest } : null; },
      async rotateCsrf(secret, digest) {
        if (secret !== sessionSecret) return null;
        sessionDigest = digest;
        return { expiresAt: new Date(Date.now() + 60_000) };
      },
    }, { origin: 'https://app.example', environment: 'test:synthetic', localHttp: false });
    const headers = { origin: 'https://app.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    const first = await csrf.bootstrap(headers);
    const cookie = first.cookies[0]!.split(';', 1)[0]!;
    await csrf.verify({ ...headers, cookie, 'x-csrf-token': first.csrfToken });
    const rotated = await csrf.bootstrap({ ...headers, cookie });
    assert.equal(rotated.cookies[0]!.split(';', 1)[0], cookie);
    assert.equal((await database.query('select id from auth_private.browser_contexts')).rows.length, 1);
    await assert.rejects(csrf.verify({ ...headers, cookie, 'x-csrf-token': first.csrfToken }), { statusCode: 403 });
    await csrf.verify({ ...headers, cookie, 'x-csrf-token': rotated.csrfToken });
    const sessionCookie = '__Host-neuton-session=' + sessionSecret;
    await assert.rejects(csrf.verify({ ...headers, cookie: sessionCookie, 'x-csrf-token': rotated.csrfToken }), { statusCode: 403 });
    const session = await csrf.bootstrap({ ...headers, cookie: sessionCookie });
    await csrf.verify({ ...headers, cookie: sessionCookie, 'x-csrf-token': session.csrfToken });
  } finally { await database.close(); }
});

test('browser mutations reject missing/null origins, hostile metadata and simple content types', () => {
  const headers = { origin: 'https://app.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  assert.doesNotThrow(() => assertBrowserMutation(headers, 'https://app.example', true));
  for (const patch of [{ origin: undefined }, { origin: 'null' }, { origin: 'https://evil.example' },
    { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': undefined }]) {
    assert.throws(() => assertBrowserMutation({ ...headers, ...patch }, 'https://app.example', true), { statusCode: 403 });
  }
});

import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import request from 'supertest';
import { AppError } from '../src/lib/errors.js';
import { GOOGLE_ISSUER, GOOGLE_OIDC, type GoogleOidc } from '../src/modules/identity/google-oidc.js';
import { SIGN_IN_LIMITER } from '../src/modules/identity/signin-limiter.js';

const origin = 'https://app.example.test';
const base = '/api/v1/auth';
const sessionCookie = '__Host-neuton-session';
const contextCookie = '__Host-neuton-context';
process.env.APP_ORIGIN = origin;
process.env.GOOGLE_CLIENT_ID = 'fixture-client';
process.env.GOOGLE_CLIENT_SECRET = 'fixture-google-secret';
process.env.GOOGLE_REDIRECT_URI = `${origin}${base}/google/callback`;
process.env.GOOGLE_OAUTH_FLOW_KEY = Buffer.alloc(32, 4).toString('hex');

function cookieFrom(response: request.Response, name: string) {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie);
  return cookie.split(';')[0]!;
}

const providerCode = 'fixture-provider-code';
const googleSubject = 'test-google-subject';

test('Google start and callback bind to the initiating browser, use safe redirects, and create no account', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const { db, sql } = await import('../src/db/client.js');
  const { SessionService } = await import('../src/modules/identity/session.service.js');
  const { LoggerImpl } = await import('../src/lib/logger/index.js');
  const connection = postgres(testDatabaseUrl!);
  const logs: unknown[] = [];
  const observed: unknown[] = [];
  const logger = new LoggerImpl({ write: (_level, message, meta) => { logs.push({ message, meta }); } }, {}, 'info');
  let exchanges = 0;
  const provider: GoogleOidc = {
    authorizationUrl: ({ state }) => `${GOOGLE_ISSUER}/o/oauth2/v2/auth?state=${state}`,
    async exchange(code) {
      exchanges++;
      if (code !== providerCode) throw new AppError(400, 'GOOGLE_PROOF_INVALID', 'provider-private-text');
      return { issuer: GOOGLE_ISSUER, subject: googleSubject, emailVerified: false };
    },
  };
  const app = await testApplication(AppModule, [[GOOGLE_OIDC, provider], [SIGN_IN_LIMITER, {
    reserve: async () => ({ releaseAccount: async () => {} }),
  }]], { origins: [origin], logger, observe: (event) => observed.push(event) });
  const api = request(app.getHttpServer());
  const status = await api.get(`${base}/google/status`).expect(200).expect('Cache-Control', 'no-store');
  assert.deepEqual(status.body, { enabled: true });
  assert.equal(status.headers['set-cookie'], undefined);
  async function browser() {
    const response = await api.post(`${base}/csrf`).set('Origin', origin).expect(200);
    return { Origin: origin, Cookie: cookieFrom(response, contextCookie), 'X-CSRF-Token': response.body.token as string };
  }
  const first = await browser();
  const other = await browser();
  const email = `${randomUUID()}@example.test`;
  const [account] = await connection`INSERT INTO users (email, password_hash, google_link_revision)
    VALUES (${email}, 'fixture-hash', 2) RETURNING id`;
  const start = (headers = first, purpose = 'sign_in') => api.post(`${base}/google/start`).set(headers).send({ purpose });
  const callback = (query: Record<string, string>, headers = first) => api.get(`${base}/google/callback`)
    .set('Cookie', headers.Cookie).query(query);
  const stateFrom = (response: request.Response) => new URL(response.body.authorizationUrl).searchParams.get('state')!;
  try {
    await start({ ...first, Origin: 'https://other.example.test' }).expect(403);
    await start({ ...first, 'X-CSRF-Token': 'invalid' }).expect(403);
    await start(first, 'link').expect(401);
    const state = stateFrom(await start().expect(200));
    const second = stateFrom(await start().expect(200));
    const third = stateFrom(await start().expect(200));
    const capped = await start().expect(429);
    assert.equal(capped.body.error.code, 'GOOGLE_ATTEMPT_LIMIT');
    await api.head(`${base}/google/callback`).set('Cookie', first.Cookie).query({ state, code: providerCode }).expect(405);
    await callback({ state, code: providerCode }, other).expect(303).expect('Location', '/signin?google=retry');
    assert.equal(exchanges, 0);
    await callback({ state: second, error: 'access_denied', error_description: 'provider-private-text' })
      .expect(303).expect('Location', '/signin?google=canceled');
    await callback({ state: third, code: 'invalid-fixture-code' }).expect(303).expect('Location', '/signin?google=retry');
    assert.equal(exchanges, 1);
    assert.ok(stateFrom(await start().expect(200)));

    await connection`INSERT INTO google_identities (user_id, issuer, subject) VALUES (${account!.id}, ${GOOGLE_ISSUER}, ${googleSubject})`;
    const returned = await callback({ state, code: providerCode, next: 'https://other.example.test' })
      .expect(303).expect('Cache-Control', 'no-store').expect('Referrer-Policy', 'no-referrer');
    const location = returned.headers.location;
    assert.ok(location);
    assert.match(location, /^\/auth\/complete#completionId=[A-Za-z0-9_-]{43}$/);
    assert.equal(returned.headers['set-cookie'], undefined);
    assert.equal(returned.text, '');
    const completion = new URLSearchParams(location.split('#')[1]).get('completionId')!;
    const digest = createHash('sha256').update(completion).digest('hex');
    const [stored] = await connection`SELECT completion_proof FROM google_attempts WHERE completion_digest = ${digest}`;
    assert.deepEqual(stored?.completion_proof.observedLink, { userId: account!.id, revision: 2 });
    assert.equal((await connection`SELECT id FROM user_sessions WHERE user_id = ${account!.id}`).length, 0);
    await callback({ state, code: providerCode }).expect(303).expect('Location', '/signin?google=retry');
    assert.equal(exchanges, 2);
    const sessions = new SessionService(db);
    const verified = { id: account!.id, securityVersion: 0, passwordHash: 'fixture-hash' };
    const initiating = await sessions.issue(verified, new Date());
    const different = await sessions.issue(verified, new Date());
    assert.ok(initiating && different);
    const cookie = `${sessionCookie}=${initiating.secret}`;
    const sessionProof = await api.post(`${base}/csrf`).set({ Origin: origin, Cookie: cookie }).expect(200);
    const linkHeaders = { Origin: origin, Cookie: cookie, 'X-CSRF-Token': sessionProof.body.token };
    await start({ ...linkHeaders, 'X-CSRF-Token': 'invalid' }, 'link').expect(403);
    const linkState = stateFrom(await start(linkHeaders, 'link').expect(200));
    await callback({ state: linkState, code: providerCode }, { ...linkHeaders, Cookie: `${sessionCookie}=${different.secret}` })
      .expect(303).expect('Location', '/profile?google=retry');
    assert.equal(exchanges, 2);
    await callback({ state: linkState, code: providerCode }, linkHeaders).expect(303);
    assert.equal(exchanges, 3);
    const logged = JSON.stringify([logs, observed]);
    for (const secret of [state, completion, providerCode, first.Cookie.split('=')[1], initiating.secret,
      first['X-CSRF-Token'], 'provider-private-text']) {
      assert.ok(secret);
      assert.ok(!logged.includes(secret), 'Callback credentials leaked into logs');
    }
  } finally {
    const digests = [first, other].map(({ Cookie }) => createHash('sha256').update(Cookie.split('=')[1]!).digest('hex'));
    await connection`DELETE FROM pre_auth_contexts WHERE secret_digest IN ${connection(digests)}`;
    await connection`DELETE FROM users WHERE id = ${account!.id}`;
    await app.close();
    await connection.end();
    await sql.end();
  }
});

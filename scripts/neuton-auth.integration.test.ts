import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import { pino } from 'pino';
import { argon2id, hash } from 'argon2';
import { SIGN_IN_LIMITER } from '../src/modules/identity/signin-limiter.js';
import { countPasswordHashSettings } from './password-hash-report.js';
import { waitForBlockedTransactions } from './support/postgresLocks.js';

const origin = 'https://app.example.test';
process.env.APP_ORIGIN = origin;
delete process.env.GOOGLE_CLIENT_ID;

type Browser = { cookie: string; proof: string };

function cookieFrom(response: request.Response, name: string) {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find((value) => value.startsWith(name + '='));
  assert.ok(cookie, 'Expected a cookie');
  return cookie.split(';')[0]!;
}

test('cookie auth preserves account/shop access and enforces session ownership and revocation', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const { db, sql } = await import('../src/db/client.js');
  const { LoggerImpl } = await import('../src/lib/logger/index.js');
  const connection = postgres(testDatabaseUrl!);
  const lines: Record<string, unknown>[] = [];
  const sink = pino({ base: null }, { write: (line) => { lines.push(JSON.parse(line)); } });
  let failedWrites = 0;
  let failDelivery = false;
  const logger = new LoggerImpl({ write: (level, message, meta) => {
    if (failDelivery) {
      failedWrites++;
      throw new Error('Test transport unavailable');
    }
    sink[level](meta, message);
  } }, {}, 'info');
  const securityEvents = () => lines.filter(({ event }) =>
    event === 'session_replaced' || event === 'session_revoked' || event === 'sessions_revoked');
  const app = await testApplication(AppModule, [[SIGN_IN_LIMITER, {
    reserve: async () => ({ releaseAccount: async () => {} }),
  }]], { origins: [origin], logger });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const email = `auth-${randomUUID()}@example.test`;
  const otherEmail = `other-${randomUUID()}@example.test`;
  const googleOnlyEmail = `google-${randomUUID()}@example.test`;
  const signupPassword = 'testpass10';
  const password = 'testpass';
  let shopId: string | undefined;
  const getProof = (cookie = '') => api.post('/api/v1/auth/csrf').set({ Origin: origin, Cookie: cookie });
  const read = (browser: Browser) => api.get('/api/v1/session').set('Cookie', browser.cookie);
  const headers = (browser: Browser) => ({ Origin: origin, Cookie: browser.cookie, 'X-CSRF-Token': browser.proof });
  async function anonymous() {
    const context = await getProof();
    assert.equal(context.status, 200);
    return { cookie: cookieFrom(context, '__Host-neuton-context'), proof: context.body.token as string };
  }
  async function authenticated(response: request.Response) {
    const cookie = cookieFrom(response, '__Host-neuton-session');
    assert.ok((response.headers['set-cookie'] as unknown as string[]).some((value) =>
      value.startsWith(cookie) && /; Path=\/;.*; HttpOnly; Secure; SameSite=Lax$/.test(value) && !value.includes('Domain=')));
    assert.equal(response.headers['cache-control'], 'no-store');
    const proof = await getProof(cookie);
    assert.equal(proof.status, 200);
    assert.deepEqual((await getProof(cookie)).body, proof.body);
    return { cookie, proof: proof.body.token as string };
  }
  const signin = (browser: Browser, candidate = password) =>
    api.post('/api/v1/auth/signin').set(headers(browser)).send({ email, password: candidate });
  try {
    await connection`WITH account AS (INSERT INTO users (email) VALUES (${googleOnlyEmail}) RETURNING id)
      INSERT INTO google_identities (user_id, issuer, subject)
      SELECT id, 'https://accounts.google.com', ${randomUUID()} FROM account`;
    const missingPassword = await api.post('/api/v1/auth/signin').set(headers(await anonymous()))
      .send({ email: googleOnlyEmail, password });
    const unknownAccount = await signin(await anonymous());
    assert.equal(missingPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    assert.equal(missingPassword.body.error.code, unknownAccount.body.error.code);
    assert.equal(missingPassword.body.error.message, unknownAccount.body.error.message);
    assert.equal(missingPassword.headers['set-cookie'], undefined);

    assert.equal((await api.post('/api/v1/auth/csrf')).status, 403);
    assert.equal((await api.post('/api/v1/auth/csrf').set('Origin', 'null')).status, 403);
    const expiredContext = await anonymous();
    const contextDigest = createHash('sha256').update(expiredContext.cookie.split('=')[1]!).digest('hex');
    await connection`UPDATE pre_auth_contexts SET expires_at = now() WHERE secret_digest = ${contextDigest}`;
    assert.equal((await signin(expiredContext)).status, 403);

    const preAuth = await anonymous();
    assert.deepEqual((await api.get('/api/v1/auth/google/status').expect(200)).body, { enabled: false });
    await api.post('/api/v1/auth/google/start').set(headers(preAuth)).send({ purpose: 'sign_in' }).expect(503);
    await api.get('/api/v1/auth/google/callback').expect(303).expect('Location', '/signin?google=unavailable');
    const signup = (candidate = signupPassword) => api.post('/api/v1/auth/signup').set(headers(preAuth)).send({
      email: ` ${email.toUpperCase()} `, password: candidate, fullName: 'Neuton Tester',
    });
    assert.equal((await signup('testpass9')).status, 400);
    assert.equal((await signup('😀'.repeat(64) + 'a')).status, 400);
    const preAuthDigest = createHash('sha256').update(preAuth.cookie.split('=')[1]!).digest('hex');
    const { pending } = await connection.begin(async (gate) => {
      const [owner] = await gate<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pre_auth_contexts
        WHERE secret_digest = ${preAuthDigest} FOR UPDATE`;
      assert.ok(owner);
      const pending = Promise.all([signup(), signup()]);
      await waitForBlockedTransactions(connection, owner.pid, 2);
      return { pending };
    });
    const attempts = await pending;
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
    const created = attempts.find((result) => result.status === 201)!;
    const { user } = created.body;
    assert.deepEqual(created.body, { user: { id: user.id, email, fullName: 'Neuton Tester', avatarUrl: null } });
    const current = await authenticated(created);
    const [stored] = await connection`SELECT password_hash FROM users WHERE id = ${user.id}`;
    assert.match(stored?.password_hash, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
    const legacy = await hash(password, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    await connection`UPDATE users SET password_hash = ${legacy} WHERE id = ${user.id}`;
    assert.equal((await api.get('/api/v1/profile').set('Cookie', current.cookie)).status, 200);
    assert.equal((await api.patch('/api/v1/profile').set('Cookie', current.cookie).send({ fullName: 'No' })).status, 403);
    const edited = await api.patch('/api/v1/profile').set(headers(current)).send({
      fullName: 'Updated Name', avatarUrl: 'https://example.com/avatar.png', passwordHash: 'untrusted',
    });
    assert.equal(edited.status, 200);
    assert.equal('passwordHash' in edited.body.profile, false);

    const shop = await api.post('/api/v1/shops').set(headers(current)).send({ name: email });
    assert.equal(shop.status, 201);
    shopId = shop.body.shop.id as string;
    assert.equal((await api.get('/api/v1/shop').set({ Cookie: current.cookie, 'x-shop-id': shopId })).status, 200);
    assert.equal((await api.get('/api/v1/shop').set({ Cookie: current.cookie, 'x-shop-id': randomUUID() })).status, 403);
    const inspection = await read(current);
    assert.equal(inspection.status, 200);
    assert.equal(inspection.headers['cache-control'], 'no-store');
    assert.equal(inspection.body.user.fullName, 'Updated Name');
    assert.deepEqual(inspection.body.memberships, [{ shop: shop.body.shop, role: 'owner' }]);
    assert.deepEqual(Object.keys(inspection.body.session).sort(), ['absoluteExpiresAt', 'id', 'idleExpiresAt', 'lastActivityAt', 'nextRenewalAt']);

    const jwt = await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('neuton').setAudience('neuton-api').setSubject(user.id).setIssuedAt().setExpirationTime('1h')
      .sign(new Uint8Array(32));
    assert.equal((await api.get('/api/v1/session').set('Authorization', `Bearer ${jwt}`)).status, 401);
    assert.equal((await read({ cookie: `__Host-neuton-session=${inspection.body.session.id}`, proof: '' })).status, 401);

    assert.equal((await signin(await anonymous(), 'wrong password')).status, 401);
    const [before] = await connection`SELECT password_hash FROM users WHERE id = ${user.id}`;
    assert.equal(before?.password_hash, legacy);
    const reportBefore = await countPasswordHashSettings(db);
    assert.ok(reportBefore.some((row) => row.settings === 'argon2id$v=19$m=19456,t=2,p=1'));
    assert.ok(reportBefore.every((row) => Object.keys(row).sort().join(',') === 'count,settings'));
    const login = await signin(await anonymous());
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.id);
    const second = await authenticated(login);
    const [upgraded] = await connection`SELECT password_hash, security_version FROM users WHERE id = ${user.id}`;
    assert.match(upgraded?.password_hash, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
    assert.notEqual(upgraded?.password_hash.split('$')[4], legacy.split('$')[4]);
    assert.equal(upgraded?.security_version, 0);
    const reportAfter = await countPasswordHashSettings(db);
    assert.equal(reportAfter.find((row) => row.settings === 'argon2id$v=19$m=19456,t=2,p=1')?.count ?? 0,
      reportBefore.find((row) => row.settings === 'argon2id$v=19$m=19456,t=2,p=1')!.count - 1);
    const secondId = (await read(second)).body.session.id;
    assert.equal((await api.get('/api/v1/session').set({ Cookie: second.cookie,
      'X-Session-Id': inspection.body.session.id })).status, 401);
    const unicodePassword = '😀'.repeat(64);
    const foreign = await authenticated(await api.post('/api/v1/auth/signup').set(headers(await anonymous()))
      .send({ email: otherEmail, password: unicodePassword }));
    const list = await api.get('/api/v1/auth/sessions').set('Cookie', current.cookie);
    assert.equal(list.body.sessions.length, 2);
    assert.equal(list.body.sessions.filter((session: { current: boolean }) => session.current).length, 1);
    const revoke = (browser: Browser, id: string) => api.delete(`/api/v1/auth/sessions/${id}`).set(headers(browser));
    assert.equal((await revoke(foreign, secondId)).status, 404);
    assert.equal((await revoke(foreign, randomUUID())).status, 404);
    assert.equal((await api.post('/api/v1/auth/logout').set({ ...headers(second), Origin: 'https://foreign.example.test' })).status, 403);
    assert.equal((await read(second)).status, 200);
    assert.equal(securityEvents().length, 0);
    assert.equal((await revoke(current, secondId)).status, 204);
    assert.equal((await revoke(current, secondId)).status, 204);
    assert.equal((await read(second)).status, 401);
    assert.equal(securityEvents().length, 1);

    const renew = () => api.post('/api/v1/auth/session/renew').set(headers(current));
    assert.deepEqual((await renew()).body, inspection.body.session);
    await connection`UPDATE user_sessions SET last_activity_at = now() - interval '6 minutes' WHERE id = ${inspection.body.session.id}`;
    const renewals = await Promise.all([renew(), renew()]);
    assert.deepEqual(renewals.map((response) => response.status), [200, 200]);
    assert.deepEqual(renewals[0]!.body, renewals[1]!.body);
    assert.equal(renewals[0]!.body.absoluteExpiresAt, inspection.body.session.absoluteExpiresAt);

    const newPassword = '😀'.repeat(64);
    const peer = await authenticated(await signin(await anonymous()));
    const signOutOnly = await authenticated(await signin(await anonymous()));
    const [afterRepeat] = await connection`SELECT password_hash FROM users WHERE id = ${user.id}`;
    assert.equal(afterRepeat?.password_hash, upgraded?.password_hash);
    assert.equal((await api.post('/api/v1/auth/logout').set(headers(signOutOnly))).status, 204);
    assert.equal((await read(signOutOnly)).status, 401);
    assert.equal((await read(current)).status, 200);
    const changePassword = (currentPassword: string, candidate = newPassword) => api.post('/api/v1/profile/password')
      .set({ ...headers(current), 'x-trace-id': 'd4a56d3002264485a58cf67368cdcaa7' }).send({ currentPassword, newPassword: candidate });
    assert.equal((await changePassword(password, 'testpass9')).status, 400);
    assert.equal((await changePassword(password, newPassword + 'a')).status, 400);
    const rejected = await changePassword('incorrect-password');
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.message, 'Current password is incorrect');
    assert.equal(rejected.headers['set-cookie'], undefined);
    assert.equal(securityEvents().length, 2);
    const changed = await changePassword(password);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body, { ok: true });
    const replacement = await authenticated(changed);
    assert.equal((await read(current)).status, 401);
    assert.equal((await read(peer)).status, 401);
    assert.equal((await read(replacement)).status, 200);
    assert.equal((await api.post('/api/v1/auth/logout').set(headers({ ...replacement, proof: current.proof }))).status, 403);
    assert.equal((await signin(await anonymous(), password)).status, 401);
    const latest = await authenticated(await signin(await anonymous(), newPassword));
    assert.equal((await api.post('/api/v1/auth/logout-all').set(headers(latest))).status, 204);
    assert.equal((await read(latest)).status, 401);
    assert.equal((await read(replacement)).status, 401);
    const events = securityEvents();
    assert.deepEqual(events.map(({ event }) => event), ['session_revoked', 'session_revoked', 'session_replaced', 'sessions_revoked']);
    for (const { event, time, userId, traceId, requestId, sessionId, reason, level, msg, ...extra } of events) {
      assert.ok(typeof time === 'number');
      assert.equal(userId, user.id);
      assert.match(String(traceId), /^[\da-f-]+$/i);
      assert.match(String(requestId), /^[\da-f-]+$/i);
      assert.equal(typeof sessionId, 'string');
      assert.equal(level, 30);
      assert.equal(typeof msg, 'string');
      assert.deepEqual(extra, { entryPoint: 'http' });
      if (event === 'session_replaced') assert.equal(traceId, changed.headers['x-trace-id']);
    }
    assert.deepEqual(events.map(({ reason }) => reason), ['targeted', 'current', undefined, undefined]);
    const captured = JSON.stringify(events);
    for (const secret of [password, newPassword, current.cookie.split('=')[1]!, current.proof, replacement.cookie.split('=')[1]!, replacement.proof]) {
      assert.ok(!captured.includes(secret), 'Security event exposed credentials');
    }
    failDelivery = true;
    assert.equal((await api.post('/api/v1/auth/logout').set(headers(foreign))).status, 204);
    failDelivery = false;
    assert.ok(failedWrites > 0);
    assert.equal((await read(foreign)).status, 401);
    const unicodeLogin = await api.post('/api/v1/auth/signin').set(headers(await anonymous()))
      .send({ email: otherEmail, password: unicodePassword });
    const unicodeBrowser = await authenticated(unicodeLogin);
    await api.post('/api/v1/profile/password').set(headers(unicodeBrowser))
      .send({ currentPassword: unicodePassword, newPassword: signupPassword }).expect(200);
  } finally {
    if (shopId) await connection`DELETE FROM shops WHERE id = ${shopId}`;
    await connection`DELETE FROM users WHERE email IN (${email}, ${otherEmail}, ${googleOnlyEmail})`;
    await app.close();
    await connection.end();
    await sql.end();
  }
});

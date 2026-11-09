import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import { pino } from 'pino';

const origin = 'https://app.example.test';
process.env.SESSION_ORIGIN = origin;

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
  const { buildApp } = await import('../src/app.js');
  const { sql } = await import('../src/db/client.js');
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
  const app = await buildApp({ http: { logger } });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const email = `auth-${randomUUID()}@example.test`;
  const otherEmail = `other-${randomUUID()}@example.test`;
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
    assert.equal((await api.post('/api/v1/auth/csrf')).status, 403);
    assert.equal((await api.post('/api/v1/auth/csrf').set('Origin', 'null')).status, 403);
    const expiredContext = await anonymous();
    const contextDigest = createHash('sha256').update(expiredContext.cookie.split('=')[1]!).digest('hex');
    await connection`UPDATE pre_auth_contexts SET expires_at = now() WHERE secret_digest = ${contextDigest}`;
    assert.equal((await signin(expiredContext)).status, 403);

    const preAuth = await anonymous();
    const signup = (candidate = password) => api.post('/api/v1/auth/signup').set(headers(preAuth)).send({
      email: ` ${email.toUpperCase()} `, password: candidate, fullName: 'Neuton Tester',
    });
    assert.equal((await signup('testpas')).status, 400);
    const attempts = await Promise.all([signup(), signup()]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
    const created = attempts.find((result) => result.status === 201)!;
    const { user } = created.body;
    assert.deepEqual(created.body, { user: { id: user.id, email, fullName: 'Neuton Tester', avatarUrl: null } });
    const current = await authenticated(created);
    const [stored] = await connection`SELECT password_hash FROM users WHERE id = ${user.id}`;
    assert.match(stored?.password_hash, /^\$argon2id\$/);
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

    const login = await signin(await anonymous());
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.id);
    const second = await authenticated(login);
    const secondId = (await read(second)).body.session.id;
    assert.equal((await api.get('/api/v1/session').set({ Cookie: second.cookie,
      'X-Session-Id': inspection.body.session.id })).status, 401);
    const foreign = await authenticated(await api.post('/api/v1/auth/signup').set(headers(await anonymous()))
      .send({ email: otherEmail, password }));
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

    const newPassword = 'nextpass';
    const peer = await authenticated(await signin(await anonymous()));
    const signOutOnly = await authenticated(await signin(await anonymous()));
    assert.equal((await api.post('/api/v1/auth/logout').set(headers(signOutOnly))).status, 204);
    assert.equal((await read(signOutOnly)).status, 401);
    assert.equal((await read(current)).status, 200);
    const changePassword = (currentPassword: string) => api.post('/api/v1/profile/password')
      .set({ ...headers(current), 'x-trace-id': 'd4a56d3002264485a58cf67368cdcaa7' }).send({ currentPassword, newPassword });
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
  } finally {
    if (shopId) await connection`DELETE FROM shops WHERE id = ${shopId}`;
    await connection`DELETE FROM users WHERE email IN (${email}, ${otherEmail})`;
    await app.close();
    await connection.end();
    await sql.end();
  }
});

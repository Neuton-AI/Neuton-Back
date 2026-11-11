import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import request from 'supertest';
import { SIGN_IN_LIMITER } from '../src/modules/identity/signin-limiter.js';
import { waitForBlockedTransactions } from './support/postgresLocks.js';

const origin = 'https://app.example.test';
const auth = '/api/v1/auth';
process.env.APP_ORIGIN = origin;

test('a Google-only account can add its first password exactly once and keep existing sessions', {
  skip: skipWithoutDisposableDatabase,
}, async (t) => {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const { db, sql } = await import('../src/db/client.js');
  const { SessionService } = await import('../src/modules/identity/session.service.js');
  const connection = postgres(testDatabaseUrl!);
  const email = `${randomUUID()}@example.test`;
  const app = await testApplication(AppModule, [[SIGN_IN_LIMITER, {
    reserve: async () => ({ releaseAccount: async () => {} }),
  }]], { origins: [origin] });
  t.after(async () => {
    await connection`DELETE FROM users WHERE email = ${email}`;
    await app.close();
    await connection.end();
    await sql.end();
  });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const subject = randomUUID();
  const [inserted] = await connection<{ id: string; securityVersion: number }[]>`
    INSERT INTO users (email, google_link_revision) VALUES (${email}, 1)
    RETURNING id, security_version AS "securityVersion"`;
  assert.ok(inserted);
  const account = inserted;
  await connection`INSERT INTO google_identities (user_id, issuer, subject)
    VALUES (${account.id}, 'https://accounts.google.com', ${subject})`;
  const sessions = new SessionService(db);
  async function browser() {
    const { session, secret } = await sessions.transaction((tx) => sessions.insert(tx, account, new Date(), 'google'));
    const Cookie = `__Host-neuton-session=${secret}`;
    const csrf = await api.post(`${auth}/csrf`).set({ Origin: origin, Cookie }).expect(200);
    return { Origin: origin, Cookie, 'X-CSRF-Token': csrf.body.token as string, 'X-Session-Id': session.id };
  }
  const first = await browser();
  const read = (binding: typeof first) => api.get('/api/v1/session').set('Cookie', binding.Cookie).expect(200);
  const googleOnly = await read(first);
  assert.equal(googleOnly.body.hasPassword, false);
  assert.equal(googleOnly.body.googleLinked, true);
  assert.doesNotMatch(googleOnly.text, /passwordHash|completionId/);
  assert.ok(!googleOnly.text.includes(subject));
  const second = await browser();
  const revoked = await browser();
  await api.post(`${auth}/logout`).set(revoked).expect(204);
  const add = (newPassword: string, binding = first) => api.post(`${auth}/password/add`).set(binding).send({ newPassword });
  const candidates = ['first-password-one', 'first-password-two'];
  await add(candidates[0]!, revoked).expect(401);
  await add(candidates[0]!, { ...first, 'X-CSRF-Token': 'wrong' }).expect(403);
  await add('short').expect(400);
  await add('a'.repeat(32_768)).expect(413);

  const changing = await browser();
  const { response } = await connection.begin(async (gate) => {
    const [owner] = await gate<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM users WHERE id = ${account.id} FOR UPDATE`;
    assert.ok(owner);
    const response = Promise.resolve(add(candidates[0]!, changing));
    await waitForBlockedTransactions(connection, owner.pid, 1);
    await gate`UPDATE user_sessions SET revoked_at = now() WHERE id = ${changing['X-Session-Id']}`;
    return { response };
  });
  assert.equal((await response).status, 401);
  const [unchanged] = await connection`SELECT password_hash FROM users WHERE id = ${account.id}`;
  assert.equal(unchanged?.password_hash, null);

  const results = await Promise.all([add(candidates[0]!), add(candidates[1]!, second)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [204, 409]);
  const winner = results.findIndex(({ status }) => status === 204);
  assert.equal(results[winner]?.headers['set-cookie'], undefined);
  assert.equal(results[1 - winner]?.body.error.code, 'PASSWORD_ALREADY_SET');
  await add('cannot-overwrite').expect(409);
  for (const binding of [first, second]) {
    const state = await read(binding);
    assert.equal(state.body.session.id, binding['X-Session-Id']);
    assert.equal(state.body.hasPassword, true);
    assert.equal(state.body.googleLinked, true);
  }
  const [stored] = await connection`SELECT password_hash, security_version, g.subject FROM users u
    JOIN google_identities g ON g.user_id = u.id WHERE u.id = ${account.id}`;
  assert.match(stored?.password_hash, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
  assert.equal(stored?.security_version, account.securityVersion);
  assert.equal(stored?.subject, subject);

  async function signIn(password: string) {
    const csrf = await api.post(`${auth}/csrf`).set('Origin', origin).expect(200);
    const cookies = csrf.headers['set-cookie'] as unknown as string[];
    const context = cookies[0]!.split(';')[0]!;
    return api.post(`${auth}/signin`).set({ Origin: origin, Cookie: context, 'X-CSRF-Token': csrf.body.token })
      .send({ email, password });
  }
  assert.equal((await signIn(candidates[1 - winner]!)).status, 401);
  const signedIn = await signIn(candidates[winner]!);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.user.id, account.id);
});

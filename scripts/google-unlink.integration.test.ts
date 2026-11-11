import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import request from 'supertest';
import { GOOGLE_ISSUER, GOOGLE_OIDC, type GoogleOidc } from '../src/modules/identity/google-oidc.js';
import { SIGN_IN_LIMITER } from '../src/modules/identity/signin-limiter.js';
import { waitForBlockedTransactions } from './support/postgresLocks.js';

const origin = 'https://app.example.test';
const auth = '/api/v1/auth';
Object.assign(process.env, {
  APP_ORIGIN: origin, GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_REDIRECT_URI: `${origin}${auth}/google/callback`, GOOGLE_OAUTH_FLOW_KEY: Buffer.alloc(32, 6).toString('base64url'),
});

function cookie(response: request.Response, name: 'session' | 'context') {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const found = cookies?.find((value) => value.startsWith(`__Host-neuton-${name}=`));
  assert.ok(found);
  return found.split(';')[0]!;
}

test('Google unlink protects the last method and atomically revokes only other Google sessions', {
  skip: skipWithoutDisposableDatabase,
}, async (t) => {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const { db, sql } = await import('../src/db/client.js');
  const { SessionService } = await import('../src/modules/identity/session.service.js');
  const connection = postgres(testDatabaseUrl!);
  const email = `${randomUUID()}@example.test`;
  const unrelatedEmail = `${randomUUID()}@example.test`;
  const subject = randomUUID();
  const provider: GoogleOidc = {
    authorizationUrl: ({ state }) => `${GOOGLE_ISSUER}/o/oauth2/v2/auth?state=${state}`,
    exchange: async () => ({ issuer: GOOGLE_ISSUER, subject, email, emailVerified: true }),
  };
  const app = await testApplication(AppModule, [[GOOGLE_OIDC, provider], [SIGN_IN_LIMITER, {
    reserve: async () => ({ releaseAccount: async () => {} }),
  }]], { origins: [origin] });
  t.after(async () => {
    await connection`DELETE FROM users WHERE email IN (${email}, ${unrelatedEmail})`;
    await app.close();
    await connection.end();
    await sql.end();
  });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const [inserted] = await connection<{ id: string; securityVersion: number }[]>`
    INSERT INTO users (email, google_link_revision) VALUES (${email}, 1)
    RETURNING id, security_version AS "securityVersion"`;
  assert.ok(inserted);
  const account = inserted;
  await connection`INSERT INTO google_identities (user_id, issuer, subject) VALUES (${account.id}, ${GOOGLE_ISSUER}, ${subject})`;
  const [unrelated] = await connection<{ id: string; securityVersion: number }[]>`
    INSERT INTO users (email) VALUES (${unrelatedEmail}) RETURNING id, security_version AS "securityVersion"`;
  assert.ok(unrelated);
  await connection`INSERT INTO google_identities (user_id, issuer, subject)
    VALUES (${unrelated.id}, ${GOOGLE_ISSUER}, ${randomUUID()})`;
  const sessions = new SessionService(db);
  async function headers(sessionCookie?: string) {
    const csrf = api.post(`${auth}/csrf`).set('Origin', origin);
    if (sessionCookie) csrf.set('Cookie', sessionCookie);
    const proof = await csrf.expect(200);
    return { Origin: origin, Cookie: sessionCookie ?? cookie(proof, 'context'), 'X-CSRF-Token': proof.body.token as string };
  }
  async function googleBrowser(owner = account) {
    const { session, secret } = await sessions.transaction((tx) => sessions.insert(tx, owner, new Date(), 'google'));
    return { ...await headers(`__Host-neuton-session=${secret}`), 'X-Session-Id': session.id };
  }
  type Browser = Awaited<ReturnType<typeof headers>>;
  async function pending(binding: Browser, purpose: 'sign_in' | 'link') {
    const started = await api.post(`${auth}/google/start`).set(binding).send({ purpose }).expect(200);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    assert.ok(state);
    const callback = await api.get(`${auth}/google/callback`).set('Cookie', binding.Cookie)
      .query({ state, code: 'fixture' }).expect(303);
    const completionId = new URLSearchParams(callback.headers.location?.split('#')[1]).get('completionId');
    assert.ok(completionId);
    return () => api.post(`${auth}/google/complete`).set(binding).send({ completionId, purpose });
  }
  const unlink = (binding: Browser) => api.delete(`${auth}/google/link`).set(binding);
  const read = (sessionCookie: string) => api.get('/api/v1/session').set('Cookie', sessionCookie);
  const linkState = async () => {
    const [state] = await connection`SELECT u.google_link_revision, g.subject FROM users u
      LEFT JOIN google_identities g ON g.user_id = u.id WHERE u.id = ${account.id}`;
    return state;
  };

  // Hold the account row until both requests are queued, then let the first waiter proceed.
  async function race(first: () => request.Test, second: () => request.Test) {
    const responses = await connection.begin(async (gate) => {
      const [owner] = await gate<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM users WHERE id = ${account.id} FOR UPDATE`;
      assert.ok(owner);
      const firstResponse = Promise.resolve(first());
      await waitForBlockedTransactions(connection, owner.pid, 1);
      const secondResponse = Promise.resolve(second());
      await waitForBlockedTransactions(connection, owner.pid, 2);
      return { firstResponse, secondResponse };
    });
    return Promise.all([responses.firstResponse, responses.secondResponse]);
  }

  const currentGoogle = await googleBrowser();
  const otherGoogle = await googleBrowser();
  const anotherGoogle = await googleBrowser();
  const unrelatedGoogle = await googleBrowser(unrelated);
  const lastMethod = await unlink(currentGoogle).expect(409);
  assert.equal(lastMethod.body.error.code, 'PASSWORD_REQUIRED');
  assert.deepEqual(await linkState(), { google_link_revision: 1, subject });
  await unlink({ ...currentGoogle, 'X-CSRF-Token': 'wrong' }).expect(403);

  const password = 'fixture-password';
  await api.post(`${auth}/password/add`).set(currentGoogle).send({ newPassword: password }).expect(204);
  const anonymous = await headers();
  const login = await api.post(`${auth}/signin`).set(anonymous).send({ email, password }).expect(200);
  const currentPassword = await headers(cookie(login, 'session'));

  await connection`UPDATE user_sessions SET device_label = 'fixture-unlink-rollback' WHERE id = ${otherGoogle['X-Session-Id']}`;
  await connection`CREATE FUNCTION fixture_reject_google_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fixture revocation failure'; END $$`;
  try {
    await connection`CREATE CONSTRAINT TRIGGER fixture_reject_google_revocation AFTER UPDATE ON user_sessions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.revocation_reason = 'google_unlink' AND NEW.device_label = 'fixture-unlink-rollback')
      EXECUTE FUNCTION fixture_reject_google_revocation()`;
    await unlink(currentGoogle).expect(503);
    assert.deepEqual(await linkState(), { google_link_revision: 1, subject });
    await read(otherGoogle.Cookie).expect(200);
    await read(anotherGoogle.Cookie).expect(200);
  } finally {
    await connection`DROP TRIGGER IF EXISTS fixture_reject_google_revocation ON user_sessions`;
    await connection`DROP FUNCTION fixture_reject_google_revocation()`;
  }

  const signInFirst = await pending(await headers(), 'sign_in');
  const proofBeforeRelink = await pending(await headers(), 'sign_in');
  const staleLink = await pending(currentGoogle, 'link');
  const [signedIn, unlinked] = await race(signInFirst, () => unlink(currentGoogle));
  assert.equal(signedIn?.status, 200);
  assert.equal(unlinked?.status, 204);
  await read(cookie(signedIn!, 'session')).expect(401);
  await read(otherGoogle.Cookie).expect(401);
  await read(anotherGoogle.Cookie).expect(401);
  await read(unrelatedGoogle.Cookie).expect(200);
  for (const binding of [currentGoogle, currentPassword]) {
    const state = await read(binding.Cookie).expect(200);
    assert.equal(state.body.hasPassword, true);
    assert.equal(state.body.googleLinked, false);
  }
  await staleLink().expect(400);
  assert.deepEqual(await linkState(), { google_link_revision: 2, subject: null });
  await unlink(currentPassword).expect(204);
  await read(currentGoogle.Cookie).expect(401);
  assert.deepEqual(await linkState(), { google_link_revision: 2, subject: null });

  const relink = await pending(currentPassword, 'link');
  await relink().expect(200);
  await proofBeforeRelink().expect(400);
  const recentGoogle = await googleBrowser();
  const unlinkFirst = await pending(await headers(), 'sign_in');
  const [removed, staleSignIn] = await race(() => unlink(currentPassword), unlinkFirst);
  assert.equal(removed?.status, 204);
  assert.equal(staleSignIn?.status, 400);
  assert.equal(staleSignIn?.headers['set-cookie'], undefined);
  await read(recentGoogle.Cookie).expect(401);
  await read(currentPassword.Cookie).expect(200);
  await read(unrelatedGoogle.Cookie).expect(200);
  assert.deepEqual(await linkState(), { google_link_revision: 4, subject: null });

  const linkAgain = await pending(currentPassword, 'link');
  await linkAgain().expect(200);
  const googleBeforeChange = await googleBrowser();
  const changed = await api.post('/api/v1/profile/password').set(googleBeforeChange)
    .send({ currentPassword: password, newPassword: 'changed-password' }).expect(200);
  await read(googleBeforeChange.Cookie).expect(401);
  await read(currentPassword.Cookie).expect(401);
  await read(cookie(changed, 'session')).expect(200);
  const signInAfterChange = await pending(await headers(), 'sign_in');
  await signInAfterChange().expect(200);
  assert.deepEqual(await linkState(), { google_link_revision: 5, subject });
});

import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import request from 'supertest';
import { GOOGLE_ISSUER, GOOGLE_OIDC, type GoogleIdentity, type GoogleOidc } from '../src/modules/identity/google-oidc.js';
import { SIGN_IN_LIMITER } from '../src/modules/identity/signin-limiter.js';

const origin = 'https://app.example.test';
const auth = '/api/v1/auth';
Object.assign(process.env, {
  APP_ORIGIN: origin, SESSION_ORIGIN: origin, GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture-secret',
  GOOGLE_REDIRECT_URI: `${origin}${auth}/google/callback`, GOOGLE_OAUTH_FLOW_KEY: Buffer.alloc(32, 5).toString('base64url'),
});

function cookie(response: request.Response, name: string) {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const found = cookies?.find((value) => value.startsWith(`__Host-neuton-${name}=`));
  assert.ok(found);
  return found.split(';')[0]!;
}

test('Google completion signs up and signs in by subject, rejects wrong binding, collisions, replay and a removed link', {
  skip: skipWithoutDisposableDatabase,
}, async (t) => {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const { sql } = await import('../src/db/client.js');
  const connection = postgres(testDatabaseUrl!);
  const subject = randomUUID();
  const email = `${randomUUID()}@example.test`;
  const passwordEmail = `${randomUUID()}@example.test`;
  const disputedEmail = `${randomUUID()}@example.test`;
  const raceEmail = `${randomUUID()}@example.test`;
  const raceOtherEmail = `${randomUUID()}@example.test`;
  const sharedEmail = `${randomUUID()}@example.test`;
  const sameBrowserEmail = `${randomUUID()}@example.test`;
  const otherPasswordEmail = `${randomUUID()}@example.test`;
  let identity: GoogleIdentity = { issuer: GOOGLE_ISSUER, subject, email: ` ${email.toUpperCase()} `,
    emailVerified: true, name: ' Google Fixture ' };
  const provider: GoogleOidc = {
    authorizationUrl: ({ state }) => `${GOOGLE_ISSUER}/o/oauth2/v2/auth?state=${state}`,
    exchange: async () => identity,
  };
  const app = await testApplication(AppModule, [[GOOGLE_OIDC, provider], [SIGN_IN_LIMITER, {
    reserve: async () => ({ releaseAccount: async () => {} }),
  }]], { origins: [origin] });
  t.after(async () => {
    await connection`DELETE FROM users WHERE email IN (${email}, ${passwordEmail}, ${disputedEmail}, ${raceEmail},
      ${raceOtherEmail}, ${sharedEmail}, ${sameBrowserEmail}, ${otherPasswordEmail})`;
    await app.close();
    await connection.end();
    await sql.end();
  });
  const api = request(app.getHttpServer());
  async function pending() {
    const csrf = await api.post(`${auth}/csrf`).set('Origin', origin).expect(200);
    const headers = { Origin: origin, Cookie: cookie(csrf, 'context'), 'X-CSRF-Token': csrf.body.token as string };
    const started = await api.post(`${auth}/google/start`).set(headers).send({ purpose: 'sign_in' }).expect(200);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    assert.ok(state);
    const callback = await api.get(`${auth}/google/callback`).set('Cookie', headers.Cookie).query({ state, code: 'fixture' }).expect(303);
    const id = new URLSearchParams(callback.headers.location?.split('#')[1]).get('completionId');
    assert.ok(id);
    return { headers, id };
  }
  const complete = (attempt: Awaited<ReturnType<typeof pending>>, headers = attempt.headers) =>
    api.post(`${auth}/google/complete`).set(headers).send({ completionId: attempt.id });
  const read = (value: string) => api.get('/api/v1/session').set('Cookie', value).expect(200);

  const signup = await pending();
  const foreign = await pending();
  await complete(signup, { ...foreign.headers }).expect(400);
  await complete(signup, { ...signup.headers, 'X-CSRF-Token': 'wrong' }).expect(403);
  const created = await complete(signup).expect(200).expect('Cache-Control', 'no-store');
  assert.deepEqual(created.body, { outcome: 'signed_up', destination: '/dashboard' });
  const cookies = created.headers['set-cookie'] as unknown as string[];
  assert.ok(cookies.some((value) => /^__Host-neuton-session=.*; Path=\/;.*; HttpOnly; Secure; SameSite=Lax$/.test(value)));
  assert.ok(cookies.some((value) => value.startsWith('__Host-neuton-context=;') && value.includes('Expires=Thu, 01 Jan 1970')));
  const current = await read(cookie(created, 'session'));
  const id = current.body.user.id as string;
  assert.deepEqual(current.body.user, { id, email, fullName: 'Google Fixture', avatarUrl: null });
  const [stored] = await connection`SELECT u.password_hash, g.subject, s.sign_in_method FROM users u
    JOIN google_identities g ON g.user_id = u.id JOIN user_sessions s ON s.user_id = u.id WHERE u.id = ${id}`;
  assert.deepEqual(stored, { password_hash: null, subject, sign_in_method: 'google' });
  await complete(signup).expect(400);

  identity = { issuer: GOOGLE_ISSUER, subject, emailVerified: false };
  const returned = await complete(await pending()).expect(200);
  assert.equal(returned.body.outcome, 'signed_in');
  assert.deepEqual((await read(cookie(returned, 'session'))).body.user, current.body.user);
  const stale = await pending();
  await connection.begin(async (tx) => {
    await tx`UPDATE users SET google_link_revision = google_link_revision + 1 WHERE id = ${id}`;
    await tx`DELETE FROM google_identities WHERE user_id = ${id}`;
  });
  await complete(stale).expect(400);
  assert.equal((await connection`SELECT user_id FROM google_identities WHERE user_id = ${id}`).length, 0);

  identity = { ...identity, subject: randomUUID(), email: disputedEmail };
  const unverified = await complete(await pending()).expect(400);
  assert.equal(unverified.body.error.code, 'GOOGLE_EMAIL_REQUIRED');
  identity = { ...identity, email: passwordEmail, emailVerified: true };
  const switched = await pending();
  const password = await api.post(`${auth}/signup`).set(switched.headers)
    .send({ email: passwordEmail, password: 'fixture-password' }).expect(201);
  const active = await complete(switched, { ...switched.headers, Cookie: `${switched.headers.Cookie}; ${cookie(password, 'session')}` })
    .expect(409);
  assert.equal(active.body.error.code, 'GOOGLE_SESSION_CHANGED');
  await complete(switched).expect(400);
  const collision = await complete(await pending()).expect(409);
  assert.equal(collision.body.error.code, 'GOOGLE_EMAIL_IN_USE');
  assert.equal((await connection`SELECT user_id FROM google_identities WHERE subject = ${identity.subject}`).length, 0);

  identity = { ...identity, subject: randomUUID(), email: raceEmail };
  const first = await pending();
  identity = { ...identity, email: raceOtherEmail };
  const second = await pending();
  const race = await Promise.all([complete(first), complete(second)]);
  assert.deepEqual(race.map(({ status }) => status).sort(), [200, 400]);
  assert.equal((await connection`SELECT id FROM users WHERE email IN (${raceEmail}, ${raceOtherEmail})`).length, 1);

  identity = { ...identity, subject: randomUUID(), email: sharedEmail };
  const sameEmail = await pending();
  const passwordBrowser = await pending();
  const passwordSignup = (attempt: Awaited<ReturnType<typeof pending>>, address: string) =>
    api.post(`${auth}/signup`).set(attempt.headers).send({ email: address, password: 'fixture-password' });
  const emailRace = await Promise.all([complete(sameEmail), passwordSignup(passwordBrowser, sharedEmail.toUpperCase())]);
  assert.ok(emailRace[0].status === 200 || emailRace[1].status === 201);
  assert.ok(emailRace.some(({ status }) => status === 409));
  assert.equal((await connection`SELECT id FROM users WHERE email = ${sharedEmail}`).length, 1);

  identity = { ...identity, subject: randomUUID(), email: sameBrowserEmail };
  const sameBrowser = await pending();
  const browserRace = await Promise.all([complete(sameBrowser), passwordSignup(sameBrowser, otherPasswordEmail)]);
  assert.equal(browserRace.filter(({ status }) => status < 300).length, 1);
  assert.equal((await connection`SELECT id FROM users WHERE email IN (${sameBrowserEmail}, ${otherPasswordEmail})`).length, 1);
});

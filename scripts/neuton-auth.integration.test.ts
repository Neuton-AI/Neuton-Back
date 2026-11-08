import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import postgres from 'postgres';
import { SignJWT } from 'jose';

const url = process.env.AUTH_TEST_DATABASE_URL;
test('app accounts sign up, own shops, sign in and reject invalid credentials and JWTs', {
  skip: !url && 'requires a migrated disposable AUTH_TEST_DATABASE_URL',
}, async () => {
  process.env.DATABASE_URL = url!;
  const { buildApp } = await import('../src/app.js');
  const { env } = await import('../src/env.js');
  const { sql } = await import('../src/db/client.js');
  const connection = postgres(url!);
  const app = await buildApp({ logger: false });
  const api = request(app.getHttpServer());
  const email = `auth-${randomUUID()}@example.com`;
  const password = 'testpass';
  let shopId: string | undefined;
  try {
    const [schema] = await connection`SELECT to_regclass('public.profiles') AS old_profiles`;
    assert.equal(schema?.old_profiles, null);
    const signup = (candidate = password) => api.post('/api/v1/auth/signup').send({
      email: ` ${email.toUpperCase()} `, password: candidate, fullName: 'Neuton Tester',
    });
    assert.equal((await signup('testpas')).status, 400);
    const attempts = await Promise.all([signup(), signup()]);
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
    const created = attempts.find((result) => result.status === 201)!;
    assert.equal(created.headers['cache-control'], 'no-store');
    const { token, user } = created.body;
    assert.deepEqual(user, { id: user.id, email, fullName: 'Neuton Tester', avatarUrl: null });
    const [stored] = await connection`SELECT password_hash FROM public.users WHERE id = ${user.id}`;
    assert.match(stored?.password_hash, /^\$argon2id\$/);
    const auth = { Authorization: `Bearer ${token}` };
    const profile = await api.get('/api/v1/profile').set(auth);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.fullName, 'Neuton Tester');
    const edited = await api.patch('/api/v1/profile').set(auth).send({
      fullName: 'Updated Name',
      avatarUrl: 'https://example.com/avatar.png',
      email: 'untrusted@example.com',
      passwordHash: 'untrusted',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.profile.fullName, 'Updated Name');
    assert.equal('passwordHash' in edited.body.profile, false);

    const shop = await api.post('/api/v1/shops').set(auth).send({ name: email });
    assert.equal(shop.status, 201);
    shopId = shop.body.shop.id as string;
    const headers = { ...auth, 'x-shop-id': shopId };
    assert.equal((await api.get('/api/v1/shop').set(headers)).status, 200);
    assert.equal((await api.get('/api/v1/shop').set({ ...headers, 'x-shop-id': randomUUID() })).status, 403);
    const session = await api.get('/api/v1/session').set(auth);
    assert.equal(session.body.user.fullName, 'Updated Name');
    assert.deepEqual(session.body.memberships, [{ shop: shop.body.shop, role: 'owner' }]);

    const signIn = (candidate: string) => api.post('/api/v1/auth/signin').send({ email, password: candidate });
    const login = await signIn(password);
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.id);
    assert.equal(login.body.user.email, email);
    assert.equal(login.body.user.avatarUrl, 'https://example.com/avatar.png');
    assert.equal((await signIn('wrong')).status, 401);
    assert.equal((await api.post('/api/v1/auth/signin').send({ email: 'absent@example.com', password })).status, 401);

    const expired = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('neuton').setAudience('neuton-api').setSubject(user.id)
      .setIssuedAt().setExpirationTime('0s').sign(Buffer.from(env.NEUTON_JWT_SECRET, 'hex'));
    for (const invalid of ['invalid-token', expired]) {
      assert.equal((await api.get('/api/v1/session').set('Authorization', `Bearer ${invalid}`)).status, 401);
    }

    const changePassword = (newPassword: string) =>
      api.post('/api/v1/profile/password').set(auth).send({ currentPassword: password, newPassword });
    assert.equal((await changePassword('nextpas')).status, 400);
    const newPassword = 'nextpass';
    const changed = await changePassword(newPassword);
    assert.equal(changed.status, 200);
    assert.equal((await signIn(password)).status, 401);
    assert.equal((await signIn(newPassword)).status, 200);
    for (let remaining = 2; remaining > 0; remaining--) {
      assert.equal((await signIn('wrong')).status, 401);
    }
    assert.equal((await signIn(newPassword)).status, 429);
  } finally {
    if (shopId) await connection`DELETE FROM public.shops WHERE id = ${shopId}`;
    await connection`DELETE FROM public.users WHERE email = ${email}`;
    await app.close();
    await connection.end();
    await sql.end();
  }
});

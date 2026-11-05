import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { testApplication } from './support/httpClient.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { AuthEncryption } from '../src/modules/auth/crypto.js';
import { ShopsModule } from '../src/modules/shops/shops.module.js';
import { SHOPS_DATABASE } from '../src/modules/shops/shops.persistence.js';
import { authUnavailable } from '../src/modules/auth/auth-errors.js';
import { IdentityRepository } from '../src/modules/identity/identity.ports.js';
import { DrizzleIdentityRepository } from '../src/modules/identity/identity.repository.js';
import type { Database } from '../src/db/client.js';

test('cookie HTTP auth enforces CSRF, pending restrictions, safe session DTOs and deliberate confirmation', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  type ApplicationTransaction = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const application = { transaction<T>(work: (transaction: ApplicationTransaction) => Promise<T>) {
    return orm.transaction(async transaction => { await transaction.execute(sql`set local role neuton_app`); return work(transaction); });
  } };
  const limits = new AuthRateLimits({ async increment(_key, windowMs) { return { count: 1, retryMs: windowMs, windowId: 'synthetic' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, application, limits);
  @Controller('api/v1/probe') class MutationProbe { @Post('mutation') mutate() { return { ok: true }; } }
  @Module({ imports: [AuthModule.forServices(services), ShopsModule], controllers: [MutationProbe] }) class Root {}
  const app = await testApplication(Root, [[SHOPS_DATABASE, application], [IdentityRepository, new DrizzleIdentityRepository(application as unknown as Database)]],
    { authOrigin: config.origin, origins: [config.origin], bodyLimit: 1_000_000 });
  try {
    const agent = request.agent(app.getHttpServer());
    const headers = { Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const boot = () => agent.post('/api/v1/auth/csrf').set(headers).send({});
    const first = await boot();
    assert.equal(first.status, 200);
    assert.ok(first.body.csrfToken);
    assert.equal(first.headers['cache-control'], 'no-store');
    const input = { email: 'alice@example.com', password: 'a long real password', fullName: 'Alice' };
    await agent.post('/api/v1/auth/register').set(headers).send(input).expect(403);
    await agent.post('/api/v1/auth/register').set({ ...headers, 'X-CSRF-Token': first.body.csrfToken }).send(input).expect(202);
    await agent.post('/api/v1/auth/login').set({ ...headers, 'X-CSRF-Token': first.body.csrfToken }).send({ email: input.email, password: input.password }).expect(204);
    const pending = await agent.get('/api/v1/session');
    assert.equal(pending.status, 200);
    assert.equal(pending.body.user.status, 'pending_email');
    assert.deepEqual(pending.body.memberships, []);
    for (const secretField of ['csrfDigest', 'tokenDigest', 'securityVersion', 'encodedHash']) assert.equal(JSON.stringify(pending.body).includes(secretField), false);
    await agent.post('/api/v1/probe/mutation').set({ ...headers, 'X-CSRF-Token': first.body.csrfToken }).send({}).expect(403);
    const pendingCsrf = await boot();
    await agent.post('/api/v1/auth/session/renew').set({ ...headers, 'X-CSRF-Token': pendingCsrf.body.csrfToken }).send({}).expect(403);
    const [row] = (await database.query<{ id: string; encrypted_payload: string; payload_key_id: string }>(
      'select id,encrypted_payload,payload_key_id from auth_private.mail_outbox')).rows;
    assert.ok(row);
    const encryption = new AuthEncryption(config.encryption.activeKeyId, config.encryption.keys);
    const payload = JSON.parse(encryption.decrypt('mail:confirm_email', row.id, { keyId: row.payload_key_id, ciphertext: row.encrypted_payload }));
    const token = /#token=([A-Za-z0-9_-]+)/.exec(payload.text)![1]!;
    await agent.get('/api/v1/auth/email/confirm?token=' + token).expect(404);
    assert.equal((await agent.get('/api/v1/session')).body.user.status, 'pending_email');
    await agent.post('/api/v1/auth/email/confirm').set({ ...headers, 'X-CSRF-Token': pendingCsrf.body.csrfToken }).send({ token }).expect(204);
    await agent.get('/api/v1/session').expect(401);
    const fresh = await boot();
    await agent.post('/api/v1/auth/login').set({ ...headers, 'X-CSRF-Token': fresh.body.csrfToken }).send({ email: input.email, password: input.password }).expect(204);
    const active = await agent.get('/api/v1/session');
    assert.equal(active.status, 200);
    assert.equal(active.body.user.status, 'active');
    assert.equal(active.body.user.fullName, 'Alice');
    assert.deepEqual(active.body.memberships, []);
    let activeCsrf = await boot();
    const reauth = { currentPassword: input.password };
    await agent.post('/api/v1/auth/reauthenticate/password').set(headers).send(reauth).expect(403);
    const protectedHeaders = () => ({ ...headers, 'X-CSRF-Token': activeCsrf.body.csrfToken });
    await agent.post('/api/v1/auth/reauthenticate/password').set(protectedHeaders()).send({ currentPassword: 'wrong long password' }).expect(401);
    await agent.post('/api/v1/auth/reauthenticate/password').set(protectedHeaders()).send({ ...reauth, userId: active.body.user.id }).expect(400);
    const append = services.events.append.bind(services.events);
    services.events.append = async () => { throw authUnavailable(); };
    const failed = await agent.post('/api/v1/auth/reauthenticate/password').set(protectedHeaders()).send(reauth).expect(503);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.equal((await agent.get('/api/v1/session')).body.session.id, active.body.session.id);
    services.events.append = append;
    await agent.post('/api/v1/auth/reauthenticate/password').set(protectedHeaders()).send(reauth).expect(204);
    const renewed = await agent.get('/api/v1/session').expect(200);
    assert.notEqual(renewed.body.session.id, active.body.session.id);
    assert.ok(renewed.body.session.recentAuthenticationExpiresAt);
    await agent.post('/api/v1/auth/reauthenticate/password').set(protectedHeaders()).send(reauth).expect(403);
    activeCsrf = await boot();
    await agent.patch('/api/v1/profile').set(protectedHeaders()).send({ email: 'attacker@example.com' }).expect(400);
    const change = { currentPassword: input.password, newPassword: 'a changed long password' };
    await agent.post('/api/v1/profile/password').set(headers).send(change).expect(403);
    await agent.post('/api/v1/profile/password').set(protectedHeaders()).send(change).expect(204);
    const changed = await agent.get('/api/v1/session').expect(200);
    assert.notEqual(changed.body.session.id, renewed.body.session.id);
    const revoked = await database.query<{ revoked: boolean }>('select revoked_at is not null as revoked from auth_private.sessions where id=$1', [renewed.body.session.id]);
    assert.equal(revoked.rows[0]?.revoked, true);
    activeCsrf = await boot();
    await agent.post('/api/v1/auth/logout').set({ ...headers, 'X-CSRF-Token': activeCsrf.body.csrfToken,
      'X-Client-User-Id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).send({}).expect(409);
    await agent.get('/api/v1/session').expect(200);
    await agent.post('/api/v1/probe/mutation').set({ ...headers, Origin: 'https://evil.example', 'X-CSRF-Token': activeCsrf.body.csrfToken }).send({}).expect(403);
    await agent.post('/api/v1/auth/register').set({ ...headers, 'X-CSRF-Token': activeCsrf.body.csrfToken }).send({ large: 'x'.repeat(17_000) }).expect(413);
    await agent.post('/api/v1/auth/logout').set({ ...headers, 'X-CSRF-Token': activeCsrf.body.csrfToken }).send({}).expect(204);
    await agent.get('/api/v1/session').expect(401);
    const recoveryCsrf = await boot();
    const recoveryHeaders = { ...headers, 'X-CSRF-Token': recoveryCsrf.body.csrfToken };
    for (const email of [input.email, 'unknown@example.com']) {
      const accepted = await agent.post('/api/v1/auth/password/recovery').set(recoveryHeaders).send({ email }).expect(202);
      assert.equal(accepted.text, '');
    }
    const resetMail = (await database.query<{ id: string; encrypted_payload: string; payload_key_id: string }>(
      "select id,encrypted_payload,payload_key_id from auth_private.mail_outbox where purpose='password_reset' and action_token_id is not null")).rows[0];
    assert.ok(resetMail);
    const resetPayload = JSON.parse(encryption.decrypt('mail:password_reset', resetMail.id, { keyId: resetMail.payload_key_id, ciphertext: resetMail.encrypted_payload }));
    const resetToken = /#token=([A-Za-z0-9_-]+)/.exec(resetPayload.text)![1]!;
    await agent.get('/api/v1/auth/password/reset').expect(404);
    const reset = { token: resetToken, newPassword: 'a recovered long password' };
    await agent.post('/api/v1/auth/password/reset').set(headers).send(reset).expect(403);
    const resetResult = await agent.post('/api/v1/auth/password/reset').set(recoveryHeaders).send(reset).expect(204);
    assert.equal(resetResult.headers['set-cookie'], undefined);
    await agent.get('/api/v1/session').expect(401);
    await agent.post('/api/v1/auth/password/reset').set(recoveryHeaders).send(reset).expect(400);
    await agent.post('/api/v1/auth/login').set(recoveryHeaders).send({ email: input.email, password: reset.newPassword }).expect(204);
    await agent.get('/api/v1/session').expect(200);
  } finally { await app.close(); await database.close(); }
});

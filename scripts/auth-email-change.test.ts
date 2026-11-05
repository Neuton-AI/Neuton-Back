import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import request from 'supertest';
import { testApplication } from './support/httpClient.js';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';

test('email changes require same-account recent proof and atomically revoke security state without changing Google identity', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits);
  @Module({ imports: [AuthModule.forServices(services)] }) class Root {}
  const app = await testApplication(Root, [], { authOrigin: config.origin, origins: [config.origin] });
  const context = { ip: '192.0.2.1', traceId: 'email-change' };
  try {
    async function active(email: string) {
      const created = await auth.transaction(transaction => services.accounts.createPending(transaction, { email }));
      assert.ok(created);
      await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [created.user.id]);
      const session = await auth.withUser(created.user.id, account => services.sessions.issue(account, { method: 'password' }, {}));
      assert.ok(session);
      return { id: created.user.id, ...session };
    }
    const owner = await active('original@example.com');
    const other = await active('occupied@example.com');
    const headers = { Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
      Cookie: `${services.csrf.cookies.name('session')}=${owner.secret}` };
    const http = request(app.getHttpServer());
    await http.post('/api/v1/auth/email/change').set(headers).send({ email: 'new@example.com' }).expect(403);
    const csrf = await http.post('/api/v1/auth/csrf').set(headers).send({}).expect(200);
    const proof = { ...headers, 'X-CSRF-Token': csrf.body.csrfToken };
    await http.post('/api/v1/auth/email/change').set(proof).send({ email: 'new@example.com', status: 'active' }).expect(400);
    await http.post('/api/v1/auth/email/change').set({ ...proof, 'X-Client-User-Id': other.id }).send({ email: 'new@example.com' }).expect(409);
    await database.query("insert into auth_private.google_identities(user_id,issuer,subject) values($1,'https://accounts.google.com','unchanged-subject')", [owner.id]);
    await services.accountService.changeEmail(owner.secret, 'New@Example.com', context, owner.id);
    assert.equal((await services.sessions.resolve(owner.secret))?.email, 'original@example.com');
    const target = await database.query<{ intended_email: string }>("select intended_email from auth_private.action_tokens where purpose='email_change'");
    assert.equal(target.rows[0]?.intended_email, 'new@example.com');
    const action = await auth.withUser(owner.id, account => services.actions.issue(account, 'email_change', 'new@example.com'));
    assert.ok(action);
    await database.query("update auth_private.action_tokens set issued_at=now()-interval '1 hour',expires_at=now()-interval '1 second' where id=$1", [action.id]);
    await assert.rejects(services.accountService.confirmEmailChange(owner.secret, action.secret, context), { code: 'INVALID_ACTION' });
    await database.query("update auth_private.action_tokens set expires_at=now()+interval '1 hour' where id=$1", [action.id]);
    await assert.rejects(services.accountService.confirmEmailChange(other.secret, action.secret, context), { code: 'ACCOUNT_CHANGED' });
    await database.query("update auth_private.sessions set recent_authenticated_at=now()-interval '11 minutes' where id=$1", [owner.sessionId]);
    await assert.rejects(services.accountService.confirmEmailChange(owner.secret, action.secret, context), { code: 'REAUTHENTICATION_REQUIRED' });
    await assert.rejects(services.accountService.changeEmail(owner.secret, 'another@example.com', context), { code: 'REAUTHENTICATION_REQUIRED' });
    await database.query('update auth_private.sessions set recent_authenticated_at=now() where id=$1', [owner.sessionId]);
    const collision = await auth.withUser(owner.id, account => services.actions.issue(account, 'email_change', 'occupied@example.com'));
    assert.ok(collision);
    await assert.rejects(services.accountService.confirmEmailChange(owner.secret, collision.secret, context), { code: 'EMAIL_UNAVAILABLE' });
    const valid = await auth.withUser(owner.id, account => services.actions.issue(account, 'email_change', 'new@example.com'));
    assert.ok(valid);
    const append = services.events.append.bind(services.events);
    services.events.append = async () => { throw new Error('audit failure'); };
    await assert.rejects(services.accountService.confirmEmailChange(owner.secret, valid.secret, context));
    assert.equal((await services.sessions.resolve(owner.secret))?.email, 'original@example.com');
    services.events.append = append;
    await http.post('/api/v1/auth/email/change/confirm').set(headers).send({ token: valid.secret }).expect(403);
    const completed = await http.post('/api/v1/auth/email/change/confirm').set(proof).send({ token: valid.secret }).expect(204);
    assert.match(String(completed.headers['set-cookie']), /Max-Age=0/);
    assert.equal(completed.headers['cache-control'], 'no-store');
    assert.equal(await services.sessions.resolve(owner.secret), null);
    assert.equal(await services.accounts.findIdByEmail('new@example.com'), owner.id);
    assert.equal(await services.accounts.findIdByEmail('original@example.com'), null);
    assert.equal((await database.query<{ subject: string }>('select subject from auth_private.google_identities')).rows[0]?.subject, 'unchanged-subject');
    const notices = await database.query<{ destination: string }>("select destination from auth_private.mail_outbox where purpose='security_notice' order by destination");
    assert.deepEqual(notices.rows.map(row => row.destination), ['new@example.com', 'original@example.com']);
    const fresh = await auth.withUser(owner.id, account => services.sessions.issue(account, { method: 'password' }, {}));
    assert.ok(fresh);
    await assert.rejects(services.accountService.confirmEmailChange(fresh.secret, valid.secret, context), { code: 'INVALID_ACTION' });
  } finally { await app.close(); await database.close(); }
});

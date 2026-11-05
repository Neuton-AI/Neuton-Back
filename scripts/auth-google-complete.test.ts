import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Module } from '@nestjs/common';
import request from 'supertest';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { testApplication } from './support/httpClient.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { newSecret } from '../src/modules/auth/crypto.js';
import type { GoogleIdentityClaims } from '../src/modules/auth/auth.ports.js';

test('Google HTTP completion enforces CSRF/browser binding, one-use tickets and current account security', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  let claims: GoogleIdentityClaims = { issuer: 'https://accounts.google.com', subject: 'google-subject', observedEmail: 'google@example.com',
    emailVerified: true, displayName: 'Person', avatarUrl: null, authenticatedAt: null };
  const services = createAuthServices(config, auth, orm, limits, {
    async authorizationUrl(input) { return `https://accounts.google.com/auth?state=${input.state}`; }, async exchange() { return claims; },
  });
  @Module({ imports: [AuthModule.forServices(services)] }) class Root {}
  const app = await testApplication(Root, [], { authOrigin: config.origin, origins: [config.origin] });
  const context = { ip: '192.0.2.1', traceId: 'google-completion' };
  const headers = { Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  try {
    const agent = request.agent(app.getHttpServer());
    let csrf = (await agent.post('/api/v1/auth/csrf').set(headers).send({}).expect(200)).body.csrfToken;
    await agent.post('/api/v1/auth/google/start').set(headers).send({ purpose: 'login' }).expect(403);
    const start = await agent.post('/api/v1/auth/google/start').set({ ...headers, 'X-CSRF-Token': csrf }).send({ purpose: 'login' }).expect(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
    const callback = await agent.get(`/api/v1/auth/google/callback?code=code&state=${state}`).expect(303);
    const ticket = new URLSearchParams(new URL(callback.headers.location!).hash.slice(1)).get('ticket')!;
    assert.ok(ticket);
    await agent.get('/api/v1/session').expect(401);
    await agent.post('/api/v1/auth/google/complete').set(headers).send({ ticket }).expect(403);
    await assert.rejects(services.google.complete(ticket, newSecret(), undefined, context), { code: 'GOOGLE_AUTH_FAILED' });
    await agent.post('/api/v1/auth/google/complete').set({ ...headers, 'X-CSRF-Token': csrf }).send({ ticket }).expect(200);
    const pending = await agent.get('/api/v1/session').expect(200);
    assert.equal(pending.body.user.status, 'pending_email');
    assert.deepEqual(pending.body.memberships, []);
    csrf = (await agent.post('/api/v1/auth/csrf').set(headers).send({}).expect(200)).body.csrfToken;
    await agent.post('/api/v1/auth/google/complete').set({ ...headers, 'X-CSRF-Token': csrf }).send({ ticket }).expect(400);
    const userId = pending.body.user.id;
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [userId]);
    // Service tests also exercise races with logout-all, expiry, and account selection.
    const current = await auth.withUser(userId, account => services.sessions.issue(account, { method: 'google' }, {}));
    assert.ok(current);
    const makeTicket = async () => {
      const started = await services.google.start({ purpose: 'reauthenticate', returnPath: '/profile' }, { sessionSecret: current.secret }, context);
      const state = new URL(started.authorizationUrl).searchParams.get('state')!;
      const redirect = await services.google.callback(new URL(`${config.google.redirectUri}?code=code&state=${state}`), started.browser.secret, context);
      return { ticket: new URLSearchParams(new URL(redirect).hash.slice(1)).get('ticket')!, browser: started.browser.secret };
    };
    claims = { ...claims, authenticatedAt: new Date() };
    const fresh = await makeTicket();
    const result = await services.google.complete(fresh.ticket, fresh.browser, current.secret, context);
    assert.equal(await services.sessions.resolve(current.secret), null);
    const resolved = await services.sessions.resolve(result.session.secret);
    assert.ok(resolved?.recentAuthenticatedAt);
    const started = await services.google.start({ purpose: 'reauthenticate' }, { sessionSecret: result.session.secret }, context);
    claims = { ...claims, subject: 'other-google' };
    const wrong = new URL(`${config.google.redirectUri}?code=code&state=${new URL(started.authorizationUrl).searchParams.get('state')}`);
    await assert.rejects(services.google.callback(wrong, started.browser.secret, context), { code: 'GOOGLE_AUTH_FAILED' });
    assert.ok(await services.sessions.resolve(result.session.secret));
    claims = { ...claims, subject: 'google-subject' };
    const revoked = await services.google.start({ purpose: 'reauthenticate' }, { sessionSecret: result.session.secret }, context);
    const revokedRedirect = await services.google.callback(new URL(`${config.google.redirectUri}?code=code&state=${new URL(revoked.authorizationUrl).searchParams.get('state')}`), revoked.browser.secret, context);
    const revokedTicket = new URLSearchParams(new URL(revokedRedirect).hash.slice(1)).get('ticket')!;
    await auth.withUser(userId, account => services.sessions.revoke(account, result.session.sessionId));
    await assert.rejects(services.google.complete(revokedTicket, revoked.browser.secret, result.session.secret, context), { code: 'GOOGLE_AUTH_FAILED' });
    const login = await services.google.start({ purpose: 'login' }, {}, context);
    const redirect = await services.google.callback(new URL(`${config.google.redirectUri}?code=code&state=${new URL(login.authorizationUrl).searchParams.get('state')}`), login.browser.secret, context);
    const staleTicket = new URLSearchParams(new URL(redirect).hash.slice(1)).get('ticket')!;
    await database.query("update auth_private.oauth_completions set created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' where ticket_digest is not null and consumed_at is null");
    await assert.rejects(services.google.complete(staleTicket, login.browser.secret, undefined, context), { code: 'GOOGLE_AUTH_FAILED' });
    await auth.withUser(userId, account => auth.invalidateSecurityState(account, 'logout_all'));
    await assert.rejects(services.google.complete(staleTicket, login.browser.secret, undefined, context), { code: 'GOOGLE_AUTH_FAILED' });
  } finally { await app.close(); await database.close(); }
});

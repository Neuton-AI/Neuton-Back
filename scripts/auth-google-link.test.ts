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
import { ArgonPasswordHasher } from '../src/modules/auth/password-hasher.js';
import type { GoogleIdentityClaims } from '../src/modules/auth/auth.ports.js';

test('explicit link preserves contact, revokes old state and exposes protected method controls over HTTP', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const claims: GoogleIdentityClaims = { issuer: 'https://accounts.google.com', subject: 'selected-google', observedEmail: 'different@example.com',
    emailVerified: true, displayName: 'Provider', avatarUrl: null, authenticatedAt: null };
  const services = createAuthServices(config, auth, orm, limits, {
    async authorizationUrl(input) { return `https://accounts.google.com/auth?state=${input.state}`; }, async exchange() { return claims; },
  });
  @Module({ imports: [AuthModule.forServices(services)] }) class Root {}
  const app = await testApplication(Root, [], { authOrigin: config.origin, origins: [config.origin] });
  const context = { ip: '192.0.2.1', traceId: 'explicit-link' };
  const headers = { Origin: config.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  try {
    const hash = await new ArgonPasswordHasher().hash('synthetic password for linking');
    const account = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'local@example.com', encodedHash: hash }));
    assert.ok(account);
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [account.user.id]);
    const current = await auth.withUser(account.user.id, account => services.sessions.issue(account, { method: 'password' }, {}));
    assert.ok(current);
    const initiated = await services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: current.secret }, context);
    const redirect = await services.google.callback(new URL(`${config.google.redirectUri}?code=code&state=${new URL(initiated.authorizationUrl).searchParams.get('state')}`), initiated.browser.secret, context);
    const ticket = new URLSearchParams(new URL(redirect).hash.slice(1)).get('ticket')!;
    const linked = await services.google.complete(ticket, initiated.browser.secret, current.secret, context);
    assert.equal(await services.sessions.resolve(current.secret), null);
    assert.equal((await services.sessions.resolve(linked.session.secret))?.email, 'local@example.com');
    const agent = request.agent(app.getHttpServer());
    const cookie = `${services.csrf.cookies.name('session')}=${linked.session.secret}`;
    const methods = await agent.get('/api/v1/auth/methods').set('Cookie', cookie).expect(200);
    assert.equal(methods.body.googleLinked, true);
    assert.equal(methods.body.passwordAvailable, true);
    assert.equal(methods.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(methods.body).includes('selected-google'), false);
    await agent.delete('/api/v1/auth/methods/google').set('Cookie', cookie).set(headers).send({}).expect(403);
    const csrf = await agent.post('/api/v1/auth/csrf').set('Cookie', cookie).set(headers).send({}).expect(200);
    const protectedHeaders = { ...headers, 'X-CSRF-Token': csrf.body.csrfToken, Cookie: cookie };
    await agent.delete('/api/v1/auth/methods/google').set(protectedHeaders).send({}).expect(403);
    await agent.post('/api/v1/auth/password/add').set(protectedHeaders).send({ newPassword: 'another synthetic password' }).expect(409);
    const reauthenticated = await services.passwords.reauthenticate((await services.sessions.resolve(linked.session.secret))!.reference, 'synthetic password for linking', context);
    const newCookie = `${services.csrf.cookies.name('session')}=${reauthenticated.secret}`;
    const newCsrf = await agent.post('/api/v1/auth/csrf').set('Cookie', newCookie).set(headers).send({}).expect(200);
    await agent.delete('/api/v1/auth/methods/google').set({ ...headers, Cookie: newCookie, 'X-CSRF-Token': newCsrf.body.csrfToken }).send({}).expect(204);
    assert.equal((await database.query('select id from auth_private.google_identities')).rows.length, 0);
  } finally { await app.close(); await database.close(); }
});

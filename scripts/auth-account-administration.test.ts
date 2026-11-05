import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { AccountAdministrationService } from '../src/modules/auth/account-administration.service.js';

test('internal disablement atomically revokes account authority and cannot be reversed by ordinary auth flows', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits, {
    async authorizationUrl(input) { return `https://accounts.google.com/auth?state=${input.state}`; },
    async exchange() { return { issuer: 'https://accounts.google.com', subject: 'disabled-subject',
      observedEmail: 'disable@example.com', emailVerified: true, authenticatedAt: null, displayName: null, avatarUrl: null }; },
  });
  const administration = new AccountAdministrationService(auth, services.events);
  try {
    const created = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'disable@example.com', fullName: 'Retained profile' }));
    assert.ok(created);
    const id = created.user.id;
    const confirmation = await auth.withUser(id, account => services.actions.issue(account, 'confirm_email', 'disable@example.com'));
    assert.ok(confirmation);
    const pendingSession = await auth.withUser(id, account => services.sessions.issue(account, { method: 'google' }, {}));
    assert.ok(pendingSession);
    const append = services.events.append.bind(services.events);
    services.events.append = async () => { throw new Error('audit failure'); };
    await assert.rejects(administration.disable(id, 'disable-rollback'));
    assert.ok(await services.sessions.resolve(pendingSession.secret));
    services.events.append = append;
    assert.equal(await administration.disable(id, 'disable-committed'), true);
    assert.equal(await services.sessions.resolve(pendingSession.secret), null);
    await assert.rejects(services.accountService.confirm(confirmation.secret, { ip: '192.0.2.1', traceId: 'disabled-confirm' }), { code: 'INVALID_ACTION' });
    await assert.rejects(auth.withUser(id, account => services.sessions.issue(account, { method: 'password' }, {})), { code: 'UNAUTHORIZED' });
    await services.passwords.recovery('disable@example.com', { ip: '192.0.2.1', traceId: 'disabled-recovery' });
    const user = (await database.query<{ status: string; security_version: number }>('select status,security_version from auth_private.users where id=$1', [id])).rows[0];
    assert.equal(user?.status, 'disabled');
    assert.equal(user?.security_version, 2);
    assert.equal((await database.query('select id from public.profiles where id=$1', [id])).rows.length, 1);
    assert.equal((await database.query("select id from auth_private.action_tokens where invalidated_at is null and consumed_at is null")).rows.length, 0);
    assert.equal(await administration.disable(id, 'disable-idempotent'), false);
    assert.equal((await database.query("select id from auth_private.security_events where event='account_disabled'")).rows.length, 1);
    const active = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'active-disable@example.com' }));
    assert.ok(active);
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [active.user.id]);
    await database.query("insert into auth_private.google_identities(user_id,issuer,subject) values($1,'https://accounts.google.com','disabled-subject')", [active.user.id]);
    const current = await auth.withUser(active.user.id, account => services.sessions.issue(account, { method: 'password' }, {}));
    assert.ok(current);
    const context = { ip: '192.0.2.1', traceId: 'disabled-google' };
    const started = await services.google.start({ purpose: 'login', returnPath: '/profile' }, {}, context);
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const redirect = await services.google.callback(new URL(`${config.google.redirectUri}?code=synthetic&state=${state}`), started.browser.secret, context);
    const ticket = new URLSearchParams(new URL(redirect).hash.slice(1)).get('ticket')!;
    await services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: current.secret }, context);
    await administration.disable(active.user.id, 'active-disabled');
    await assert.rejects(services.google.complete(ticket, started.browser.secret, current.secret, context));
    await assert.rejects(services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: current.secret }, context));
    assert.equal((await database.query("select id from auth_private.oauth_transactions where initiating_user_id=$1 and status in ('pending','claimed')", [active.user.id])).rows.length, 0);
    assert.equal((await database.query('select id from auth_private.oauth_completions where target_user_id=$1 and consumed_at is null', [active.user.id])).rows.length, 0);
  } finally { await database.close(); }
});

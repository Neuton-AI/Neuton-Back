import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { ArgonPasswordHasher } from '../src/modules/auth/password-hasher.js';

test('method changes require current proof, preserve a usable method and atomically replace security state', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits);
  const context = { ip: '192.0.2.1', traceId: 'method-transitions' };
  try {
    const account = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'google@example.com' }));
    assert.ok(account);
    const id = account.user.id;
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [id]);
    await database.query("insert into auth_private.google_identities(user_id,issuer,subject) values($1,'https://accounts.google.com','subject')", [id]);
    const login = await auth.withUser(id, account => services.sessions.issue(account, { method: 'google' }, {}));
    assert.ok(login);
    const initial = await services.methods.list(login.secret);
    assert.equal(initial.passwordAvailable, false);
    assert.equal(initial.googleLinked, true);
    assert.equal(initial.capabilities.addPassword, false);
    await assert.rejects(services.methods.addPassword(login.secret, 'new synthetic password', context), { code: 'REAUTHENTICATION_REQUIRED' });
    const fresh = await auth.withUser(id, account => services.sessions.issue(account, { method: 'google', recentAuthenticatedAt: new Date() }, {}));
    assert.ok(fresh);
    await assert.rejects(services.methods.unlinkGoogle(fresh.secret, context), { code: 'LAST_LOGIN_METHOD' });
    assert.equal((await services.methods.list(fresh.secret)).capabilities.addPassword, true);
    const append = services.events.append.bind(services.events);
    services.events.append = async () => { throw new Error('simulate transaction failure'); };
    await assert.rejects(services.methods.addPassword(fresh.secret, 'new synthetic password', context));
    assert.equal(await services.accounts.findPasswordForUser(id), null);
    assert.ok(await services.sessions.resolve(fresh.secret));
    services.events.append = append;
    const added = await services.methods.addPassword(fresh.secret, 'new synthetic password', context);
    assert.equal(await services.sessions.resolve(fresh.secret), null);
    assert.equal(await services.sessions.resolve(login.secret), null);
    const proof = await services.accounts.findPasswordForUser(id);
    assert.ok(proof);
    assert.equal(await new ArgonPasswordHasher().verify(proof.encodedHash, 'new synthetic password'), true);
    assert.equal(proof.securityVersion, 2);
    assert.equal((await services.methods.list(added.secret)).passwordAvailable, true);
    await assert.rejects(services.methods.addPassword(added.secret, 'another synthetic password', context), { code: 'PASSWORD_ALREADY_EXISTS' });
    const unlinked = await services.methods.unlinkGoogle(added.secret, context);
    assert.equal(await services.sessions.resolve(added.secret), null);
    const methods = await services.methods.list(unlinked.secret);
    assert.equal(methods.googleLinked, false);
    assert.equal(methods.passwordAvailable, true);
    assert.equal(methods.capabilities.linkGoogle, true);
    assert.equal((await services.accounts.findPasswordForUser(id))?.securityVersion, 3);
    assert.equal((await database.query('select id from auth_private.mail_outbox')).rows.length, 2);
    await assert.rejects(services.methods.list(unlinked.secret, '00000000-0000-4000-8000-000000000001'), { code: 'ACCOUNT_CHANGED' });
  } finally { await database.close(); }
});

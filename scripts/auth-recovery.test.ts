import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { AuthEncryption } from '../src/modules/auth/crypto.js';
import { ArgonPasswordHasher } from '../src/modules/auth/password-hasher.js';
import { authUnavailable } from '../src/modules/auth/auth-errors.js';
import { PasswordService } from '../src/modules/auth/password.service.js';

test('recovery stays generic and reset atomically replaces only a confirmed password account', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, windowMs) {
    return { count: 1, retryMs: windowMs, windowId: 'synthetic' };
  }, async release() {} }, config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits);
  const hasher = new ArgonPasswordHasher();
  const hash = await hasher.hash('original synthetic password');
  const context = { ip: '192.0.2.1', traceId: 'synthetic-recovery' };
  try {
    const create = (email: string, password = true) => auth.transaction(async transaction => {
      const account = await services.accounts.createPending(transaction, { email, encodedHash: password ? hash : undefined });
      assert.ok(account);
      return account.user.id;
    });
    const userId = await create('eligible@example.com');
    const googleId = await create('google@example.com', false);
    const disabledId = await create('disabled@example.com');
    await create('pending@example.com');
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=any($1::uuid[])", [[userId, googleId, disabledId]]);
    await database.query("update auth_private.users set status='disabled' where id=$1", [disabledId]);
    for (const email of ['eligible@example.com', 'google@example.com', 'disabled@example.com', 'pending@example.com', 'unknown@example.com']) {
      assert.equal(await services.passwords.recovery(email, context), undefined);
    }
    const actions = await database.query('select id from auth_private.action_tokens');
    assert.equal(actions.rows.length, 1);
    const mail = await database.query<{ id: string; payload_key_id: string; encrypted_payload: string }>('select id,payload_key_id,encrypted_payload from auth_private.mail_outbox');
    assert.equal(mail.rows.length, 1);
    const row = mail.rows[0]!;
    const content = JSON.parse(new AuthEncryption(config.encryption.activeKeyId, config.encryption.keys).decrypt('mail:password_reset', row.id,
      { keyId: row.payload_key_id, ciphertext: row.encrypted_payload }));
    const token = /#token=([A-Za-z0-9_-]+)/.exec(content.text)![1]!;
    const first = await auth.withUser(userId, account => services.sessions.issue(account, { method: 'password' }, {}));
    const second = await auth.withUser(userId, account => services.sessions.issue(account, { method: 'password' }, {}));
    assert.ok(first); assert.ok(second);
    const append = services.events.append.bind(services.events);
    services.events.append = async () => { throw authUnavailable(); };
    await assert.rejects(services.passwords.reset(token, 'replacement synthetic password', context), { code: 'AUTH_UNAVAILABLE' });
    assert.ok(await services.sessions.resolve(first.secret));
    assert.equal((await database.query<{ consumed_at: unknown }>('select consumed_at from auth_private.action_tokens')).rows[0]?.consumed_at, null);
    services.events.append = append;
    await services.passwords.reset(token, 'replacement synthetic password', context);
    assert.equal(await services.sessions.resolve(first.secret), null);
    assert.equal(await services.sessions.resolve(second.secret), null);
    const credential = await services.accounts.findPasswordForUser(userId);
    assert.ok(credential);
    assert.equal(credential.securityVersion, 2);
    assert.equal(await hasher.verify(credential.encodedHash, 'replacement synthetic password'), true);
    await assert.rejects(services.passwords.reset(token, 'another synthetic password', context), { code: 'INVALID_ACTION' });
    const state = await database.query<{ event: string }>("select event from auth_private.security_events where event='password_reset'");
    assert.equal(state.rows.length, 1);
    const expired = await auth.withUser(userId, account => services.actions.issue(account, 'password_reset', null));
    assert.ok(expired);
    await database.query("update auth_private.action_tokens set issued_at=now()-interval '2 days',expires_at=now()-interval '1 day' where id=$1", [expired.id]);
    await assert.rejects(services.passwords.reset(expired.secret, 'another synthetic password', context), { code: 'INVALID_ACTION' });
    const racingToken = await auth.withUser(userId, account => services.actions.issue(account, 'password_reset', null));
    assert.ok(racingToken);
    const racing = new PasswordService(auth, services.accounts, services.sessions, {
      verify: (hash, password) => hasher.verify(hash, password), verifyDummy: password => hasher.verifyDummy(password), needsRehash: () => false,
      async hash(password) {
        await auth.withUser(userId, account => auth.invalidateSecurityState(account, 'logout_all'));
        return hasher.hash(password);
      },
    }, limits, services.events, services.outbox, services.actions);
    await assert.rejects(racing.reset(racingToken.secret, 'racing synthetic password', context), { code: 'INVALID_ACTION' });
    assert.equal((await services.accounts.findPasswordForUser(userId))?.encodedHash, credential.encodedHash);
  } finally { await database.close(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { AuthEncryption, newSecret } from '../src/modules/auth/crypto.js';

test('Google start binds encrypted transactions to browser and exact authenticated purpose', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits, {
    async authorizationUrl(input) { return `https://accounts.google.com/auth?state=${input.state}`; },
    async exchange() { throw new Error('not called'); },
  });
  const context = { ip: '192.0.2.1', traceId: 'google-start' };
  try {
    const first = await services.google.start({ purpose: 'login', returnPath: '/dashboard' }, {}, context);
    assert.ok(first.browser);
    assert.ok(first.authorizationUrl.startsWith('https://accounts.google.com/'));
    const rows = await database.query<{ id: string; encrypted_verifier: string; verifier_key_id: string; state_digest: string }>('select * from auth_private.oauth_transactions');
    const row = rows.rows[0]!;
    const verifier = new AuthEncryption(config.encryption.activeKeyId, config.encryption.keys).decrypt('oauth_pkce', row.id,
      { keyId: row.verifier_key_id, ciphertext: row.encrypted_verifier });
    assert.equal(verifier.length, 43);
    assert.equal(JSON.stringify(rows.rows).includes(new URL(first.authorizationUrl).searchParams.get('state')!), false);
    assert.equal((await database.query('select id from auth_private.sessions')).rows.length, 0);
    const browserSecret = first.browser.secret;
    for (let i = 1; i < 5; i++) await services.google.start({ purpose: 'login', returnPath: '/' }, { browserSecret }, context);
    await assert.rejects(services.google.start({ purpose: 'login', returnPath: '/' }, { browserSecret }, context), { code: 'OAUTH_LIMIT' });
    await assert.rejects(services.google.start({ purpose: 'login', returnPath: '//attacker.example' }, {}, context));
    await assert.rejects(services.google.start({ purpose: 'link', returnPath: '/profile' }, {}, context), { statusCode: 401 });
    const user = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'link@example.com' }));
    assert.ok(user);
    const pending = await auth.withUser(user.user.id, account => services.sessions.issue(account, { method: 'password' }, {}));
    assert.ok(pending);
    await assert.rejects(services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: pending.secret }, context), { statusCode: 403 });
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [user.user.id]);
    const started = await services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: pending.secret, browserSecret: newSecret() }, context);
    assert.ok(started.browser);
    const initiated = (await database.query<{ initiating_user_id: string; initiating_session_id: string; expected_security_version: number }>("select * from auth_private.oauth_transactions where purpose='link'")).rows[0]!;
    assert.equal(initiated.initiating_user_id, user.user.id);
    assert.equal(initiated.initiating_session_id, pending.sessionId);
    assert.equal(initiated.expected_security_version, 1);
    await database.query("update auth_private.sessions set recent_authenticated_at=now()-interval '11 minutes' where id=$1", [pending.sessionId]);
    await assert.rejects(services.google.start({ purpose: 'link', returnPath: '/profile' }, { sessionSecret: pending.secret }, context), { code: 'REAUTHENTICATION_REQUIRED' });
  } finally { await database.close(); }
});

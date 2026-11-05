import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { newSecret } from '../src/modules/auth/crypto.js';
import type { GoogleIdentityClaims } from '../src/modules/auth/auth.ports.js';

test('Google callback claims once, preserves accounts, rejects collisions, and clears verifier on every outcome', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  let calls = 0;
  let fail = false;
  let claims: GoogleIdentityClaims = { issuer: 'https://accounts.google.com', subject: 'google-subject', observedEmail: 'google@example.com',
    emailVerified: true, displayName: 'Original name', avatarUrl: null, authenticatedAt: null };
  const services = createAuthServices(config, auth, orm, limits, {
    async authorizationUrl(input) { return `https://accounts.google.com/auth?state=${input.state}`; },
    async exchange() { calls++; if (fail) throw new Error('private provider failure'); return claims; },
  });
  const context = { ip: '192.0.2.1', traceId: 'google-callback' };
  const start = () => services.google.start({ purpose: 'login' }, {}, context);
  const callback = (started: Awaited<ReturnType<typeof start>>, browserSecret = started.browser.secret, error = false) => {
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const url = new URL(`${config.google.redirectUri}?state=${state}&${error ? 'error=access_denied' : 'code=one-use-code'}`);
    return services.google.callback(url, browserSecret, context);
  };
  try {
    const first = await start();
    await assert.rejects(callback(first, newSecret()), { code: 'GOOGLE_AUTH_FAILED' });
    assert.equal(calls, 0);
    const redirect = await callback(first);
    assert.equal(new URL(redirect).pathname, '/auth/google/complete');
    assert.ok(new URL(redirect).hash.startsWith('#ticket='));
    const users = await database.query<{ id: string; email: string; status: string }>('select id,email,status from auth_private.users');
    assert.equal(users.rows.length, 1);
    assert.equal(users.rows[0]!.status, 'pending_email');
    assert.equal((await database.query('select id from auth_private.mail_outbox')).rows.length, 1);
    assert.equal((await database.query('select id from auth_private.sessions')).rows.length, 0);
    await assert.rejects(callback(first), { code: 'GOOGLE_AUTH_FAILED' });
    assert.equal(calls, 1);
    await database.query("update public.profiles set full_name='User edited' where id=$1", [users.rows[0]!.id]);
    claims = { ...claims, observedEmail: 'changed-google@example.com', displayName: 'Provider changed' };
    await callback(await start());
    assert.equal((await database.query<{ full_name: string }>('select full_name from public.profiles')).rows[0]!.full_name, 'User edited');
    assert.equal((await database.query<{ email: string }>('select email from auth_private.users')).rows[0]!.email, 'google@example.com');
    claims = { ...claims, subject: 'different-subject', observedEmail: 'google@example.com' };
    await assert.rejects(callback(await start()), { code: 'GOOGLE_EMAIL_COLLISION' });
    assert.equal((await database.query('select id from auth_private.google_identities')).rows.length, 1);
    fail = true;
    const failed = await start();
    await assert.rejects(callback(failed), { code: 'GOOGLE_AUTH_FAILED' });
    fail = false;
    await assert.rejects(callback(failed), { code: 'GOOGLE_AUTH_FAILED' });
    const cancelled = await start();
    const before = calls;
    await assert.rejects(callback(cancelled, cancelled.browser.secret, true), { code: 'GOOGLE_AUTH_FAILED' });
    assert.equal(calls, before);
    const secrets = await database.query('select id from auth_private.oauth_transactions where encrypted_verifier is not null or verifier_key_id is not null');
    assert.equal(secrets.rows.length, 0);
    const completion = (await database.query<{ lifetime: number }>("select extract(epoch from (expires_at-created_at))::int as lifetime from auth_private.oauth_completions")).rows;
    assert.ok(completion.every(row => row.lifetime <= 60));
  } finally { await database.close(); }
});

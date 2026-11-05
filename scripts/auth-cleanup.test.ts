import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';

test('cleanup-only routines remove completed secrets in bounded batches and enforce metadata retention without affecting live authority', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, retryMs) { return { count: 1, retryMs, windowId: 'test' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, auth, orm, limits);
  const cleanup = (batch: number) => orm.transaction(async transaction => {
    await transaction.execute(sql`set local role neuton_cleanup`);
    await transaction.execute(sql`select app_private.cleanup_auth_records(${batch}::integer)`);
  });
  try {
    const account = await auth.transaction(transaction => services.accounts.createPending(transaction, { email: 'cleanup@example.com' }));
    assert.ok(account);
    for (let index = 0; index < 3; index += 1) {
      await auth.withUser(account.user.id, async locked => {
        const action = await services.actions.issue(locked, 'confirm_email', locked.user.normalizedEmail);
        await services.outbox.enqueueAction(locked, action);
      });
    }
    const expired = await auth.withUser(account.user.id, locked => services.sessions.issue(locked, { method: 'password' }, {}));
    const live = await auth.withUser(account.user.id, locked => services.sessions.issue(locked, { method: 'password' }, {}));
    assert.ok(expired && live);
    await database.query("update auth_private.sessions set authenticated_at=now()-interval '70 days',last_activity_at=now()-interval '65 days',idle_expires_at=now()-interval '60 days',absolute_expires_at=now()-interval '40 days',revoked_at=now() where id=$1", [expired.sessionId]);
    await auth.transaction(async transaction => {
      for (let index = 0; index < 3; index += 1) await services.events.append(transaction, { event: 'login', result: 'success', correlationId: 'cleanup-retention', sessionId: expired.sessionId });
    });
    await database.query("update auth_private.security_events set created_at=now()-interval '91 days'");
    await auth.transaction(transaction => services.events.append(transaction, { event: 'login', result: 'success', correlationId: 'retained-event' }));
    await cleanup(1);
    assert.equal((await database.query('select id from auth_private.mail_outbox')).rows.length, 2);
    assert.equal((await database.query("select id from auth_private.security_events where correlation_id='cleanup-retention'")).rows.length, 2);
    for (let iteration = 0; iteration < 5; iteration += 1) await cleanup(1);
    assert.equal((await database.query('select id from auth_private.mail_outbox')).rows.length, 1);
    assert.equal((await database.query('select id from auth_private.action_tokens')).rows.length, 1);
    assert.equal((await database.query('select id from auth_private.sessions where id=$1', [expired.sessionId])).rows.length, 0);
    assert.ok(await services.sessions.resolve(live.secret));
    assert.equal((await database.query('select id from auth_private.security_events')).rows.length, 1);
    await assert.rejects(orm.transaction(async tx => { await tx.execute(sql`set local role neuton_cleanup`); await tx.execute(sql`select * from auth_private.mail_outbox`); }), /permission denied/);
    await assert.rejects(orm.transaction(async tx => { await tx.execute(sql`set local role neuton_auth`); await tx.execute(sql`select app_private.cleanup_auth_records(1)`); }), /permission denied/);
    await assert.rejects(orm.transaction(async tx => { await tx.execute(sql`set local role neuton_auth`); await tx.execute(sql`delete from auth_private.security_events`); }), /permission denied/);
  } finally { await database.close(); }
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { AuthRepository } from '../src/modules/auth/auth.repository.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { ActionTokenRepository } from '../src/modules/auth/action-token.repository.js';
import type { AuthTransaction } from '../src/modules/auth/auth.ports.js';
import { SecurityEvents } from '../src/modules/auth/security-events.js';

test('auth account and action transitions are atomic, version-bound and identity-safe', async () => {
  const database = new PGlite();
  try {
    await database.exec(`create role neuton_app; create role neuton_auth; create role neuton_worker;
      create role neuton_cleanup; create role neuton_policy_reader nologin; create role neuton_bootstrap nologin`);
    const directory = new URL('../drizzle-neon/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await database.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    const orm = drizzle(database);
    const auth = new AuthRepository({
      transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T> {
        return orm.transaction(async transaction => {
          await transaction.execute(sql`set local role neuton_auth`);
          return work(transaction);
        });
      },
    });
    const accounts = new AccountRepository(auth);
    const actions = new ActionTokenRepository(auth);
    const events = new SecurityEvents();
    const encodedHash = '$argon2id$v=19$m=65536,t=3,p=1$S04tyw074m/eXVryuv7liA$TI44HwWFmhrQ79vWkMQVmudNvCwgte6f/vzLMrdus80';
    const created = await auth.transaction(async transaction => {
      const account = await accounts.createPending(transaction, {
        email: ' Alice+Tag@Example.com ', fullName: 'Alice', encodedHash,
      });
      assert.ok(account);
      const token = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      const projection = await accounts.publicProjection(account);
      await events.append(transaction, { event: 'registration_requested', result: 'success', correlationId: 'registered',
        subjectUserId: account.user.id });
      assert.equal(projection.fullName, 'Alice');
      assert.equal('securityVersion' in projection, false);
      assert.equal('encodedHash' in projection, false);
      return { id: account.user.id, token };
    });
    const collision = await auth.transaction(transaction => accounts.createPending(transaction, {
      email: 'alice+tag@example.com', fullName: 'Attacker', encodedHash: encodedHash + 'different',
    }));
    assert.equal(collision, null);
    const other = await auth.transaction(transaction => accounts.createPending(transaction, { email: 'other@example.com' }));
    assert.ok(other);
    await auth.withUser(other.user.id, async account => {
      assert.equal(await actions.consume(account, { purpose: 'confirm_email', secret: created.token.secret }), null);
    });
    assert.equal((await accounts.findPassword('alice+tag@example.com'))?.encodedHash, encodedHash);
    const pendingProof = await accounts.findPassword('alice+tag@example.com');
    assert.ok(pendingProof);
    assert.equal((await actions.find('confirm_email', created.token.secret))?.userId, created.id);
    assert.equal(await actions.find('password_reset', created.token.secret), null);
    const escapedScope = await auth.withUser(created.id, async account => account);
    assert.ok(escapedScope);
    await assert.rejects(accounts.publicProjection(escapedScope), /Current locked auth account/);
    await auth.withUser(created.id, async account => {
      assert.equal(await accounts.credentialUnchanged(account, pendingProof), true);
      assert.equal(await actions.consume(account, { purpose: 'password_reset', secret: created.token.secret }), null);
      assert.ok(await actions.consume(account, { purpose: 'confirm_email', secret: created.token.secret }));
      assert.equal(await actions.consume(account, { purpose: 'confirm_email', secret: created.token.secret }), null);
    });
    const replaced = await auth.withUser(created.id, async account => {
      const first = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      const second = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      assert.equal(await actions.consume(account, { purpose: 'confirm_email', secret: first.secret }), null);
      return second;
    });
    assert.ok(replaced);
    await assert.rejects(auth.transaction(async transaction => {
      await accounts.createPending(transaction, { email: 'rollback@example.com', fullName: 'Rollback', encodedHash });
      await events.append(transaction, { event: 'registration_requested', result: 'success', correlationId: 'rolled-back' });
      throw new Error('rollback synthetic transaction');
    }), /rollback synthetic/);
    assert.equal(await accounts.findPassword('rollback@example.com'), null);
    const persistedEvents = await database.query<{ correlation_id: string }>('select correlation_id from auth_private.security_events');
    assert.deepEqual(persistedEvents.rows, [{ correlation_id: 'registered' }]);

    const sessionId = randomUUID();
    const oauthId = randomUUID();
    await database.query(`insert into auth_private.sessions(id,user_id,token_digest,csrf_digest,security_version,authenticated_at,
      authentication_method,last_activity_at,idle_expires_at,absolute_expires_at)
      values($1,$2,$3,$3,1,now(),'password',now(),now()+interval '7 days',now()+interval '30 days')`,
    [sessionId, created.id, 'd'.repeat(64)]);
    await auth.withUser(created.id, async account => {
      const browserId = randomUUID();
      await account.transaction.execute(sql`insert into auth_private.browser_contexts
        (id,token_digest,csrf_digest,environment,expires_at) values(${browserId}::uuid,${'e'.repeat(64)},${'e'.repeat(64)},'synthetic',
        clock_timestamp()+interval '30 minutes')`);
      await account.transaction.execute(sql`insert into auth_private.oauth_transactions
        (id,state_digest,browser_context_id,purpose,initiating_user_id,initiating_session_id,expected_security_version,
        nonce,encrypted_verifier,verifier_key_id,return_path,expires_at)
        values(${oauthId}::uuid,${'f'.repeat(64)},${browserId}::uuid,'link',${created.id}::uuid,${sessionId}::uuid,1,
        'synthetic','synthetic encrypted verifier','synthetic-key','/',clock_timestamp()+interval '10 minutes')`);
      await account.transaction.execute(sql`insert into auth_private.oauth_completions
        (ticket_digest,transaction_id,target_user_id,identity,expected_security_version,expires_at)
        values(${'a'.repeat(64)},${oauthId}::uuid,${created.id}::uuid,
        '{"issuer":"https://accounts.google.com","subject":"synthetic"}'::jsonb,1,clock_timestamp()+interval '1 minute')`);
      assert.equal(await accounts.replacePassword(account, encodedHash + 'stale', encodedHash + 'new'), false);
      assert.equal(await accounts.replacePassword(account, encodedHash, encodedHash + 'new', true), true);
      assert.equal(await accounts.credentialUnchanged(account, pendingProof), false);
      await auth.invalidateSecurityState(account, 'password_changed');
      assert.equal(await accounts.replacePassword(account, encodedHash + 'new', encodedHash + 'stale'), false);
    });
    const state = await database.query<{ security_version: number; revoked_at: Date | null }>(`
      select u.security_version,s.revoked_at from auth_private.users u join auth_private.sessions s on s.user_id=u.id where u.id=$1`,
    [created.id]);
    assert.equal(state.rows[0]?.security_version, 2);
    assert.ok(state.rows[0]?.revoked_at);
    const oauth = await database.query<{ status: string; encrypted_verifier: string | null; consumed_at: Date | null }>(`
      select t.status,t.encrypted_verifier,c.consumed_at from auth_private.oauth_transactions t
      join auth_private.oauth_completions c on c.transaction_id=t.id where t.id=$1`, [oauthId]);
    assert.equal(oauth.rows[0]?.status, 'failed');
    assert.equal(oauth.rows[0]?.encrypted_verifier, null);
    assert.ok(oauth.rows[0]?.consumed_at);
    assert.equal((await accounts.findPassword('alice+tag@example.com'))?.passwordChangedAt.getTime(), pendingProof.passwordChangedAt.getTime());
    await auth.withUser(created.id, async account => {
      assert.equal(await actions.consume(account, { purpose: 'confirm_email', secret: replaced.secret }), null);
      const expired = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      await account.transaction.execute(sql`update auth_private.action_tokens set issued_at=clock_timestamp()-interval '2 days',
        expires_at=clock_timestamp()-interval '1 day' where id=${expired.id}::uuid`);
      assert.equal(await actions.consume(account, { purpose: 'confirm_email', secret: expired.secret }), null);
    });
    await database.query(`update auth_private.users set status='active',email_confirmed_at=now() where id=$1`, [created.id]);
    await auth.withUser(created.id, async account => {
      const token = await actions.issue(account, 'email_change', 'next@example.com');
      assert.equal(await actions.consume(account, {
        purpose: 'email_change', secret: token.secret, intendedEmail: 'wrong@example.com',
      }), null);
      assert.ok(await actions.consume(account, {
        purpose: 'email_change', secret: token.secret, intendedEmail: 'next@example.com',
      }));
      const reset = await actions.issue(account, 'password_reset', null);
      assert.ok(await actions.consume(account, { purpose: 'password_reset', secret: reset.secret }));
      await auth.lockUser(account.transaction, created.id.toUpperCase());
      await assert.rejects(auth.lockUser(account.transaction, randomUUID()), /One user per auth transaction/);
    });
    const rollbackAction = await auth.withUser(created.id, account => actions.issue(account, 'password_reset', null));
    assert.ok(rollbackAction);
    await assert.rejects(auth.withUser(created.id, async account => {
      assert.ok(await actions.consume(account, { purpose: 'password_reset', secret: rollbackAction.secret }));
      throw new Error('rollback synthetic action');
    }), /rollback synthetic action/);
    await auth.withUser(created.id, async account => {
      assert.ok(await actions.consume(account, { purpose: 'password_reset', secret: rollbackAction.secret }));
    });
    await database.query(`update auth_private.users set status='disabled' where id=$1`, [created.id]);
    await auth.withUser(created.id, async account => {
      await assert.rejects(actions.issue(account, 'confirm_email', account.user.normalizedEmail));
      assert.equal(await accounts.credentialUnchanged(account, pendingProof), false);
    });
  } finally {
    await database.close();
  }
});

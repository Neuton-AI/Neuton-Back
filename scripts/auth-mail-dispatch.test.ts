import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { AuthRepository } from '../src/modules/auth/auth.repository.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { ActionTokenRepository } from '../src/modules/auth/action-token.repository.js';
import { MailOutboxRepository } from '../src/modules/auth/mail-outbox.repository.js';
import { MailDispatcher } from '../src/modules/auth/mail-dispatcher.js';
import { MailTemplates } from '../src/modules/auth/mail-templates.js';
import { AuthEncryption } from '../src/modules/auth/crypto.js';
import type { AuthTransaction, AuthMailMessage } from '../src/modules/auth/auth.ports.js';

test('durable mail dispatch fences leases, retries failures and discards superseded actions', { timeout: 20_000 }, async () => {
  const database = new PGlite();
  try {
    await database.exec(`create role neuton_app; create role neuton_auth; create role neuton_worker;
      create role neuton_cleanup; create role neuton_policy_reader nologin; create role neuton_bootstrap nologin`);
    const directory = new URL('../drizzle-neon/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await database.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    const orm = drizzle(database);
    const auth = new AuthRepository({ transaction<T>(work: (transaction: AuthTransaction) => Promise<T>) {
      return orm.transaction(async transaction => {
        await transaction.execute(sql`set local role neuton_auth`);
        return work(transaction);
      });
    } });
    const accounts = new AccountRepository(auth);
    const actions = new ActionTokenRepository(auth);
    const outbox = new MailOutboxRepository(auth, new AuthEncryption('synthetic', new Map([['synthetic', Buffer.alloc(32, 9)]])),
      new MailTemplates('https://neuton.example'));
    const created = await auth.transaction(async transaction => {
      const account = await accounts.createPending(transaction, { email: 'synthetic@example.com' });
      assert.ok(account);
      const first = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      const supersededId = await outbox.enqueueAction(account, first);
      const current = await actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      const currentId = await outbox.enqueueAction(account, current);
      return { userId: account.user.id, supersededId, currentId };
    });
    const sent: AuthMailMessage[] = [];
    const logs: unknown[] = [];
    let fail = false;
    const dispatcher = new MailDispatcher(outbox, { async send(message) {
      // A new SQL transaction here must complete: SMTP is never called under an account lock.
      await auth.withUser(created.userId, async account => { assert.equal(account.user.status, 'pending_email'); });
      if (fail) throw new Error('private provider response and mail content');
      sent.push(message);
    } }, { info: metadata => logs.push(metadata), warn: metadata => logs.push(metadata) });
    await dispatcher.runOnce();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.id, created.currentId);
    const completed = await database.query<{ id: string; sent_at: Date | null; discarded_at: Date | null; encrypted_payload: string | null }>(
      'select id,sent_at,discarded_at,encrypted_payload from auth_private.mail_outbox');
    assert.ok(completed.rows.find(row => row.id === created.currentId)?.sent_at);
    assert.ok(completed.rows.find(row => row.id === created.supersededId)?.discarded_at);
    assert.ok(completed.rows.every(row => row.encrypted_payload === null));

    const noticeId = await auth.withUser(created.userId, account => outbox.enqueueNotice(account, 'sessions_revoked'));
    assert.ok(noticeId);
    fail = true;
    await dispatcher.runOnce();
    const retry = await database.query<{ attempts: number; next_attempt_at: Date; sent_at: Date | null; last_error_code: string; encrypted_payload: string }>(
      'select attempts,next_attempt_at,sent_at,last_error_code,encrypted_payload from auth_private.mail_outbox where id=$1', [noticeId]);
    assert.equal(retry.rows[0]?.attempts, 1);
    assert.ok(retry.rows[0]!.next_attempt_at.getTime() > Date.now());
    assert.equal(retry.rows[0]?.sent_at, null);
    assert.equal(retry.rows[0]?.last_error_code, 'MAIL_DELIVERY_UNAVAILABLE');
    assert.ok(retry.rows[0]?.encrypted_payload);
    assert.equal(JSON.stringify(logs).includes('private'), false);
    await dispatcher.runOnce();
    assert.equal(sent.length, 1);
    fail = false;
    await database.query('update auth_private.mail_outbox set next_attempt_at=now()-interval \'1 second\' where id=$1', [noticeId]);
    await dispatcher.runOnce();
    assert.equal(sent.length, 2);

    await auth.withUser(created.userId, async account => {
      await outbox.enqueueNotice(account, 'sessions_revoked');
      await outbox.enqueueNotice(account, 'password_changed');
    });
    const [firstClaims, secondClaims] = await Promise.all([outbox.claim(1), outbox.claim(1)]);
    assert.equal(firstClaims.length, 1);
    assert.equal(secondClaims.length, 1);
    assert.notEqual(firstClaims[0]?.id, secondClaims[0]?.id);
    const stale = firstClaims[0]!;
    await database.query('update auth_private.mail_outbox set lease_until=now()-interval \'1 second\' where id=$1', [stale.id]);
    const [replacement] = await outbox.claim(1);
    assert.ok(replacement);
    assert.equal(replacement.id, stale.id);
    assert.notEqual(replacement.leaseToken, stale.leaseToken);
    assert.equal(await outbox.markSent(stale), false);
    assert.equal(await outbox.retry(stale, 'MAIL_DELIVERY_UNAVAILABLE'), false);
    assert.equal(await outbox.prepare(stale), null);
    assert.ok(await outbox.prepare(replacement));
    assert.equal(await outbox.extend(replacement), true);
    await database.query('update auth_private.mail_outbox set attempts=20 where id=$1', [replacement.id]);
    assert.equal(await outbox.retry(replacement, 'MAIL_DELIVERY_UNAVAILABLE'), true);
    const backoff = await database.query<{ next_attempt_at: Date }>('select next_attempt_at from auth_private.mail_outbox where id=$1', [replacement.id]);
    assert.ok(backoff.rows[0]!.next_attempt_at.getTime() <= Date.now() + 3_601_000);
    const expiredId = await auth.withUser(created.userId, account => outbox.enqueueNotice(account, 'sessions_revoked'));
    await database.query(`update auth_private.mail_outbox set created_at=now()-interval '2 days',
      expires_at=now()-interval '1 day' where id=$1`, [expiredId]);
    await dispatcher.runOnce();
    assert.equal(sent.length, 2);
    assert.equal((await database.query<{ encrypted_payload: string | null }>(
      'select encrypted_payload from auth_private.mail_outbox where id=$1', [expiredId])).rows[0]?.encrypted_payload, null);
    await dispatcher.stop();

    await auth.withUser(created.userId, account => outbox.enqueueNotice(account, 'password_changed'));
    let releaseSend: () => void = () => {};
    let sendEntered: () => void = () => {};
    const sending = new Promise<void>(resolve => { sendEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseSend = resolve; });
    const draining = new MailDispatcher(outbox, { async send() { sendEntered(); await release; } }, {
      info: metadata => logs.push(metadata), warn: metadata => logs.push(metadata),
    });
    const activeDrain = draining.runOnce();
    await sending;
    let stopped = false;
    const shutdown = draining.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    releaseSend();
    await Promise.all([activeDrain, shutdown]);
    assert.equal(stopped, true);
  } finally { await database.close(); }
});

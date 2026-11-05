import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { digestSecret, newSecret } from '../src/modules/auth/crypto.js';

test('opaque sessions recheck status/version/expiry and rotate or revoke atomically', async () => {
  const { database, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const sessions = new SessionRepository(auth);
    const issued = await auth.transaction(async transaction => {
      const account = await accounts.createPending(transaction, { email: 'synthetic@example.com' });
      assert.ok(account);
      return sessions.issue(account, { method: 'password' }, { userAgent: 'synthetic', ip: '192.0.2.1' });
    });
    const pending = await sessions.resolve(issued.secret);
    assert.ok(pending);
    assert.equal(pending.status, 'pending_email');
    assert.notEqual(pending.id, issued.secret);
    assert.equal(await sessions.resolve(pending.id), null);
    const before = pending.lastActivityAt.getTime();
    await sessions.resolve(issued.secret);
    assert.equal((await sessions.resolve(issued.secret))?.lastActivityAt.getTime(), before);
    const csrf = newSecret();
    await sessions.rotateCsrf(issued.secret, digestSecret('csrf', csrf));
    assert.equal((await sessions.csrfContext(issued.secret))?.csrfDigest, digestSecret('csrf', csrf));
    await database.query(`update auth_private.sessions set authenticated_at=now()-interval '20 minutes',last_activity_at=now()-interval '10 minutes',
      idle_expires_at=now()+interval '1 day' where id=$1`, [pending.id]);
    const renewed = await sessions.withSession(issued.secret, (account, session) => sessions.renew(account, session));
    assert.ok(renewed);
    assert.equal(renewed.absoluteExpiresAt.getTime(), pending.absoluteExpiresAt.getTime());
    assert.ok(renewed.idleExpiresAt.getTime() > pending.lastActivityAt.getTime() + 6 * 86_400_000);
    const activity = (await sessions.resolve(issued.secret))!.lastActivityAt.getTime();
    const throttled = await sessions.withSession(issued.secret, (account, session) => sessions.renew(account, session));
    assert.equal(throttled?.idleExpiresAt.getTime(), renewed.idleExpiresAt.getTime());
    assert.equal((await sessions.resolve(issued.secret))?.lastActivityAt.getTime(), activity);
    await database.query(`update auth_private.sessions set authenticated_at=now()-interval '29 days',
      last_activity_at=now()-interval '10 minutes',idle_expires_at=now()+interval '30 minutes',
      absolute_expires_at=now()+interval '1 hour' where id=$1`, [pending.id]);
    const capped = await sessions.withSession(issued.secret, (account, session) => sessions.renew(account, session));
    assert.ok(capped);
    assert.equal(capped.idleExpiresAt.getTime(), capped.absoluteExpiresAt.getTime());
    assert.ok(await sessions.resolve(issued.secret));
    const replacement = await sessions.withSession(issued.secret, (account, session) =>
      sessions.issue(account, { method: 'password' }, {}, session.id));
    assert.ok(replacement);
    assert.equal(await sessions.resolve(issued.secret), null);
    assert.ok(await sessions.resolve(replacement.secret));
    await auth.withUser(pending.userId, async account => {
      await auth.invalidateSecurityState(account, 'password_changed');
    });
    assert.equal(await sessions.resolve(replacement.secret), null);
    const another = await auth.withUser(pending.userId, account => sessions.issue(account, { method: 'google', recentAuthenticatedAt: null }, {}));
    assert.ok(another);
    assert.equal((await sessions.resolve(another.secret))?.recentAuthenticatedAt, null);
    await database.query("update auth_private.sessions set authenticated_at=now()-interval '2 minutes',idle_expires_at=now()-interval '1 second',last_activity_at=now()-interval '1 minute' where id=$1", [another.sessionId]);
    assert.equal(await sessions.resolve(another.secret), null);
    await database.query("update auth_private.users set status='disabled' where id=$1", [pending.userId]);
    await assert.rejects(auth.withUser(pending.userId, account => sessions.issue(account, { method: 'password' }, {})));
    const raw = await database.query<{ token_digest: string }>('select token_digest from auth_private.sessions');
    assert.equal(JSON.stringify(raw.rows).includes(another.secret), false);
  } finally { await database.close(); }
});

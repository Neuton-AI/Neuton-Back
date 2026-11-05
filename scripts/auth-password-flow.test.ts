import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { ActionTokenRepository } from '../src/modules/auth/action-token.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { MailOutboxRepository } from '../src/modules/auth/mail-outbox.repository.js';
import { AuthEncryption } from '../src/modules/auth/crypto.js';
import { MailTemplates } from '../src/modules/auth/mail-templates.js';
import { ArgonPasswordHasher } from '../src/modules/auth/password-hasher.js';
import { SecurityEvents } from '../src/modules/auth/security-events.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';
import { AccountService } from '../src/modules/auth/account.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { registrationInput, loginInput } from '../src/modules/auth/contracts.js';

test('registration, pending login, resend and deliberate confirmation preserve account ownership', async () => {
  const { database, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const actions = new ActionTokenRepository(auth);
    const sessions = new SessionRepository(auth);
    const encryption = new AuthEncryption('synthetic', new Map([['synthetic', Buffer.alloc(32, 19)]]));
    const outbox = new MailOutboxRepository(auth, encryption, new MailTemplates('https://neuton.example'));
    const hasher = new ArgonPasswordHasher();
    const events = new SecurityEvents();
    const counters = new Map<string, number>();
    const limits = new AuthRateLimits({ async increment(key, windowMs) {
      const count = (counters.get(key) ?? 0) + 1; counters.set(key, count);
      return { count, retryMs: windowMs, windowId: 'synthetic' };
    }, async release(key) { counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1)); } },
    Buffer.alloc(32, 31), 'test:synthetic', 'neuton:auth:test:synthetic');
    const accountService = new AccountService(auth, accounts, actions, outbox, hasher, limits, events, sessions);
    const passwords = new PasswordService(auth, accounts, sessions, hasher, limits, events, outbox, actions);
    const context = { ip: '192.0.2.1', traceId: 'synthetic-flow' };
    const input = registrationInput.parse({ email: ' Alice+Tag@Example.com ', password: 'a long real password', fullName: 'Alice' });
    await accountService.register(input, context);
    await accountService.register({ ...input, fullName: 'Attacker', password: 'different long password' }, context);
    assert.equal((await database.query('select id from auth_private.users')).rows.length, 1);
    assert.equal((await database.query<{ full_name: string }>('select full_name from public.profiles')).rows[0]?.full_name, 'Alice');
    const pending = await passwords.login(loginInput.parse({ email: input.email.display, password: input.password }), context);
    assert.equal((await sessions.resolve(pending.secret))?.status, 'pending_email');
    await accountService.resend(input.email.normalized, context);
    const mail = await database.query<{ id: string; encrypted_payload: string; payload_key_id: string }>(
      'select id,encrypted_payload,payload_key_id from auth_private.mail_outbox order by created_at desc');
    assert.equal(mail.rows.length, 2);
    const readToken = (row: typeof mail.rows[number]) => {
      const payload = JSON.parse(encryption.decrypt('mail:confirm_email', row.id, { keyId: row.payload_key_id, ciphertext: row.encrypted_payload }));
      return /#token=([A-Za-z0-9_-]+)/.exec(payload.text)![1]!;
    };
    await assert.rejects(accountService.confirm(readToken(mail.rows[1]!), context), { code: 'INVALID_ACTION' });
    const token = readToken(mail.rows[0]!);
    await accountService.confirm(token, context);
    assert.equal(await sessions.resolve(pending.secret), null);
    await assert.rejects(accountService.confirm(token, context), { code: 'INVALID_ACTION' });
    const active = await passwords.login(loginInput.parse({ email: input.email.display, password: input.password }), context);
    assert.equal((await sessions.resolve(active.secret))?.status, 'active');
    for (const email of [input.email.display, 'missing@example.com']) {
      await assert.rejects(passwords.login(loginInput.parse({ email, password: 'wrong long password' }), context), {
        code: 'INVALID_CREDENTIALS', message: 'Invalid email or password',
      });
    }
    const changedHash = await hasher.hash('a different new password');
    const racing = new PasswordService(auth, accounts, sessions, {
      hash: password => hasher.hash(password), verifyDummy: password => hasher.verifyDummy(password), needsRehash: () => false,
      async verify(encodedHash, password) {
        const valid = await hasher.verify(encodedHash, password);
        const proof = await accounts.findPassword(input.email.normalized);
        assert.ok(proof);
        await auth.withUser(proof.userId, async account => {
          await accounts.replacePassword(account, proof.encodedHash, changedHash);
          await auth.invalidateSecurityState(account, 'password_changed');
        });
        return valid;
      },
    }, limits, events, outbox, actions);
    await assert.rejects(racing.login(loginInput.parse({ email: input.email.display, password: input.password }), context), { code: 'INVALID_CREDENTIALS' });
    assert.equal(await sessions.resolve(active.secret), null);
    const changedLogin = await passwords.login(loginInput.parse({ email: input.email.display, password: 'a different new password' }), context);
    const verified = await sessions.resolve(changedLogin.secret);
    assert.ok(verified);
    const beforeFailedChange = await accounts.findPasswordForUser(verified.userId);
    await assert.rejects(passwords.change(verified.reference, { currentPassword: 'wrong long password', newPassword: 'a final replacement password' }, context), { code: 'INVALID_CREDENTIALS' });
    assert.equal((await accounts.findPasswordForUser(verified.userId))?.encodedHash, beforeFailedChange?.encodedHash);
    const finalSession = await passwords.change(verified.reference, { currentPassword: 'a different new password', newPassword: 'a final replacement password' }, context);
    assert.equal(await sessions.resolve(changedLogin.secret), null);
    assert.ok(await sessions.resolve(finalSession.secret));
    const beforeReauth = await sessions.resolve(finalSession.secret);
    assert.ok(beforeReauth);
    await assert.rejects(passwords.reauthenticate(beforeReauth.reference, 'wrong long password', context), { code: 'INVALID_CREDENTIALS' });
    assert.ok(await sessions.resolve(finalSession.secret));
    const replacement = await passwords.reauthenticate(beforeReauth.reference, 'a final replacement password', context);
    assert.equal(await sessions.resolve(finalSession.secret), null);
    const afterReauth = await sessions.resolve(replacement.secret);
    assert.ok(afterReauth);
    assert.equal(afterReauth.securityVersion, beforeReauth.securityVersion);
    assert.notEqual(afterReauth.csrfDigest, beforeReauth.csrfDigest);
    assert.ok(afterReauth.recentAuthenticatedAt);
    await assert.rejects(passwords.reauthenticate(beforeReauth.reference, 'a final replacement password', context), { code: 'INVALID_CREDENTIALS' });
  } finally { await database.close(); }
});

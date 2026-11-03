import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { LockedAuthAccount } from './auth.repository.js';
import { digestSecret, newSecret } from './crypto.js';
import { isBearerSecret, normalizeEmail } from './normalization.js';

export type ActionPurpose = 'confirm_email' | 'password_reset' | 'email_change';
type ConsumeAction = { purpose: 'confirm_email' | 'password_reset'; secret: string } |
  { purpose: 'email_change'; secret: string; intendedEmail: string };

export class ActionTokenRepository {
  constructor(private readonly auth: AuthRepository) {}

  async issue(account: LockedAuthAccount, purpose: ActionPurpose, intendedEmail: string | null) {
    this.auth.assertLocked(account);
    const user = account.user;
    const expectedStatus = purpose === 'confirm_email' ? 'pending_email' : 'active';
    if (user.status !== expectedStatus || (purpose !== 'password_reset' && !intendedEmail) ||
      (purpose === 'password_reset' && intendedEmail !== null) ||
      (intendedEmail !== null && normalizeEmail(intendedEmail).normalized !== intendedEmail) ||
      (purpose === 'confirm_email' && intendedEmail !== user.normalizedEmail)) {
      throw new Error('Action destination or account status invalid');
    }
    const id = randomUUID();
    const secret = newSecret();
    const lifetimeMs = purpose === 'password_reset' ? AUTH_POLICY.tokens.recoveryMs : AUTH_POLICY.tokens.confirmationMs;
    await account.transaction.execute(sql`update auth_private.action_tokens set invalidated_at=clock_timestamp()
      where user_id=${user.id}::uuid and purpose=${purpose} and consumed_at is null and invalidated_at is null`);
    const [issued] = await authRows(account.transaction, sql`insert into auth_private.action_tokens
      (id,user_id,purpose,token_digest,intended_email,security_version,issued_at,expires_at)
      select ${id}::uuid,id,${purpose},${digestSecret(purpose, secret)},${intendedEmail},security_version,
        clock_timestamp(),clock_timestamp()+${lifetimeMs}*interval '1 millisecond'
      from auth_private.users where id=${user.id}::uuid and status=${expectedStatus} and security_version=${user.securityVersion}
      returning expires_at as "expiresAt"`, z.object({ expiresAt: z.coerce.date() }));
    if (!issued) throw new Error('Account changed during action issuance');
    return { id, secret, purpose, intendedEmail, securityVersion: user.securityVersion, expiresAt: issued.expiresAt };
  }

  /** A lookup selects the user to lock; it is never proof that the action may execute. */
  find(purpose: ActionPurpose, secret: string): Promise<{ userId: string; intendedEmail: string | null } | null> {
    if (!isBearerSecret(secret)) return Promise.resolve(null);
    return this.auth.transaction(async transaction => {
      const [token] = await authRows(transaction, sql`select user_id as "userId",intended_email as "intendedEmail"
        from auth_private.action_tokens where purpose=${purpose} and token_digest=${digestSecret(purpose, secret)}`,
      z.object({ userId: z.string().uuid(), intendedEmail: z.string().nullable() }));
      return token ?? null;
    });
  }

  async consume(account: LockedAuthAccount, action: ConsumeAction): Promise<{ id: string; intendedEmail: string | null } | null> {
    this.auth.assertLocked(account);
    const { user } = account;
    if (!isBearerSecret(action.secret)) return null;
    const expectedStatus = action.purpose === 'confirm_email' ? 'pending_email' : 'active';
    if (user.status !== expectedStatus) return null;
    let intendedEmail: string | null = user.normalizedEmail;
    if (action.purpose === 'password_reset') intendedEmail = null;
    if (action.purpose === 'email_change') intendedEmail = normalizeEmail(action.intendedEmail).normalized;
    const [consumed] = await authRows(account.transaction, sql`update auth_private.action_tokens t
      set consumed_at=clock_timestamp() where t.user_id=${user.id}::uuid and t.purpose=${action.purpose}
      and t.token_digest=${digestSecret(action.purpose, action.secret)} and t.security_version=${user.securityVersion}
      and t.intended_email is not distinct from ${intendedEmail} and t.consumed_at is null and t.invalidated_at is null
      and t.expires_at>clock_timestamp() and exists(select 1 from auth_private.users u where u.id=t.user_id
        and u.security_version=t.security_version and u.status=${expectedStatus}
        and (${action.purpose}<>'confirm_email' or u.normalized_email=t.intended_email))
      returning t.id,t.intended_email as "intendedEmail"`, z.object({ id: z.string().uuid(), intendedEmail: z.string().nullable() }));
    return consumed ?? null;
  }
}

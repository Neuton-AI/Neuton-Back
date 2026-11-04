import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { conflict } from '../../lib/errors.js';
import type { AuthPersistence, AuthTransaction } from './auth.ports.js';
import { mapAuthDependencyError } from './auth-errors.js';
import { queryRows as authRows } from '../../db/query-rows.js';
export { authRows };

const userSchema = z.object({ id: z.string().uuid(), email: z.string(), normalizedEmail: z.string(),
  status: z.enum(['pending_email', 'active', 'disabled']), securityVersion: z.number().int().positive(),
  emailConfirmedAt: z.coerce.date().nullable() });
const lockedAccount = Symbol('LockedAuthAccount');
export interface LockedAuthAccount {
  readonly [lockedAccount]: true;
  readonly user: Readonly<z.infer<typeof userSchema>>;
  readonly transaction: AuthTransaction;
}

export class AuthRepository {
  private readonly activeTransactions = new WeakSet<AuthTransaction>();
  private readonly transactionUsers = new WeakMap<AuthTransaction, string>();
  private readonly locks = new WeakSet<LockedAuthAccount>();

  constructor(private readonly persistence: AuthPersistence) {}

  async transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.persistence.transaction(async transaction => {
        this.activeTransactions.add(transaction);
        try {
          return await work(transaction);
        } finally {
          this.activeTransactions.delete(transaction);
          this.transactionUsers.delete(transaction);
        }
      });
    } catch (error) {
      throw mapAuthDependencyError(error);
    }
  }

  withUser<T>(userId: string, work: (account: LockedAuthAccount) => Promise<T>): Promise<T | null> {
    return this.transaction(async transaction => {
      const account = await this.lockUser(transaction, userId);
      if (!account) return null;
      return work(account);
    });
  }

  async lockUser(transaction: AuthTransaction, userId: string): Promise<LockedAuthAccount | null> {
    if (!this.activeTransactions.has(transaction)) throw new Error('Auth transaction required');
    const canonicalId = z.string().uuid().parse(userId).toLowerCase();
    const lockedUserId = this.transactionUsers.get(transaction);
    if (lockedUserId !== undefined && lockedUserId !== canonicalId) throw new Error('One user per auth transaction required');
    this.transactionUsers.set(transaction, canonicalId);
    // Same canonical guard as tenant capabilities, exclusive before any account/credential/action row lock.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('neuton:user:'||${userId}::uuid::text,0))`);
    const [user] = await authRows(transaction, sql`select id,email,normalized_email as "normalizedEmail",status,
      security_version as "securityVersion",email_confirmed_at as "emailConfirmedAt"
      from auth_private.users where id=${userId}::uuid for update`, userSchema);
    if (!user) return null;
    const account: LockedAuthAccount = Object.freeze({ [lockedAccount]: true as const, user: Object.freeze(user), transaction });
    this.locks.add(account);
    return account;
  }

  assertLocked(account: LockedAuthAccount): void {
    if (!this.locks.has(account) || !this.activeTransactions.has(account.transaction)) {
      throw new Error('Current locked auth account required');
    }
  }

  async invalidateSecurityState(account: LockedAuthAccount, reason: string): Promise<number> {
    this.assertLocked(account);
    if (!/^[a-z_]{1,80}$/.test(reason)) throw new Error('Invalid revocation reason');
    const { id, securityVersion } = account.user;
    const [updated] = await authRows(account.transaction, sql`update auth_private.users
      set security_version=security_version+1,updated_at=clock_timestamp()
      where id=${id}::uuid and security_version=${securityVersion} returning security_version as version`, z.object({ version: z.number() }));
    if (!updated) throw conflict('Account changed; try again');
    await account.transaction.execute(sql`update auth_private.sessions set revoked_at=clock_timestamp(),revoked_reason=${reason}
      where user_id=${id}::uuid and revoked_at is null`);
    await account.transaction.execute(sql`update auth_private.action_tokens set invalidated_at=clock_timestamp()
      where user_id=${id}::uuid and consumed_at is null and invalidated_at is null`);
    await account.transaction.execute(sql`update auth_private.oauth_transactions set status='failed',encrypted_verifier=null,verifier_key_id=null
      where initiating_user_id=${id}::uuid and status in ('pending','claimed')`);
    await account.transaction.execute(sql`update auth_private.oauth_completions set consumed_at=clock_timestamp()
      where (target_user_id=${id}::uuid or candidate_user_id=${id}::uuid) and consumed_at is null`);
    return updated.version;
  }
}

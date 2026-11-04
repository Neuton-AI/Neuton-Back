import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthTransaction } from './auth.ports.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { LockedAuthAccount } from './auth.repository.js';
import { normalizeEmail } from './normalization.js';

const credentialSchema = z.object({ userId: z.string().uuid(), encodedHash: z.string(),
  passwordChangedAt: z.coerce.date(), securityVersion: z.number(), status: z.enum(['pending_email', 'active', 'disabled']) });
export type PasswordProof = z.infer<typeof credentialSchema>;
const profileSchema = z.object({ id: z.string().uuid(), fullName: z.string().nullable(), avatarUrl: z.string().nullable() });

export class AccountRepository {
  constructor(private readonly auth: AuthRepository) {}

  findIdByEmail(normalizedEmail: string): Promise<string | null> {
    return this.auth.transaction(async transaction => {
      const [user] = await authRows(transaction, sql`select id from auth_private.users where normalized_email=${normalizedEmail}`,
        z.object({ id: z.string().uuid() }));
      return user?.id ?? null;
    });
  }

  async createPending(transaction: AuthTransaction, input: {
    email: string; fullName?: string; avatarUrl?: string; encodedHash?: string;
  }): Promise<LockedAuthAccount | null> {
    const email = normalizeEmail(input.email);
    const id = randomUUID();
    await this.auth.lockUser(transaction, id);
    const [inserted] = await authRows(transaction, sql`insert into auth_private.users(id,email,normalized_email)
      values(${id}::uuid,${email.display},${email.normalized}) on conflict(normalized_email) do nothing returning id`,
    z.object({ id: z.string().uuid() }));
    if (!inserted) return null;
    await transaction.execute(sql`select app_private.create_profile(${id}::uuid,${input.fullName ?? null},${input.avatarUrl ?? null})`);
    if (input.encodedHash !== undefined) {
      this.validateHash(input.encodedHash);
      await transaction.execute(sql`insert into auth_private.password_credentials(user_id,encoded_hash)
        values(${id}::uuid,${input.encodedHash})`);
    }
    return this.auth.lockUser(transaction, id);
  }

  findPassword(normalizedEmail: string): Promise<PasswordProof | null> {
    return this.auth.transaction(async transaction => {
      const [proof] = await authRows(transaction, sql`select u.id as "userId",p.encoded_hash as "encodedHash",
        p.password_changed_at as "passwordChangedAt",u.security_version as "securityVersion",u.status
        from auth_private.users u join auth_private.password_credentials p on p.user_id=u.id
        where u.normalized_email=${normalizedEmail}`, credentialSchema);
      return proof ?? null;
    });
  }

  async publicProjection(account: LockedAuthAccount) {
    this.auth.assertLocked(account);
    const [profile] = await authRows(account.transaction, sql`select id,full_name as "fullName",avatar_url as "avatarUrl"
      from app_private.auth_profile(${account.user.id}::uuid)`, profileSchema);
    if (!profile) throw new Error('Account profile missing');
    return { ...profile, email: account.user.email, status: account.user.status,
      emailConfirmedAt: account.user.emailConfirmedAt?.toISOString() ?? null };
  }

  async credentialUnchanged(account: LockedAuthAccount, proof: PasswordProof): Promise<boolean> {
    this.auth.assertLocked(account);
    if (account.user.id !== proof.userId || account.user.status === 'disabled' ||
      account.user.securityVersion !== proof.securityVersion) return false;
    const [current] = await authRows(account.transaction, sql`select p.encoded_hash as hash,p.password_changed_at as changed
      from auth_private.password_credentials p join auth_private.users u on u.id=p.user_id
      where p.user_id=${account.user.id}::uuid and u.security_version=${proof.securityVersion}
      and u.status in ('pending_email','active') for update of p`,
    z.object({ hash: z.string(), changed: z.coerce.date() }));
    return current !== undefined && current.hash === proof.encodedHash &&
      current.changed.getTime() === proof.passwordChangedAt.getTime();
  }

  async replacePassword(account: LockedAuthAccount, expectedHash: string, encodedHash: string, rehash = false): Promise<boolean> {
    this.auth.assertLocked(account);
    this.validateHash(encodedHash);
    if (account.user.status === 'disabled') return false;
    const [updated] = await authRows(account.transaction, sql`update auth_private.password_credentials p
      set encoded_hash=${encodedHash},password_changed_at=case when ${rehash} then password_changed_at else clock_timestamp() end
      where p.user_id=${account.user.id}::uuid and p.encoded_hash=${expectedHash}
      and exists(select 1 from auth_private.users u where u.id=p.user_id and u.security_version=${account.user.securityVersion}
        and u.status in ('pending_email','active'))
      returning user_id as id`, z.object({ id: z.string().uuid() }));
    return updated !== undefined;
  }

  private validateHash(encodedHash: string): void {
    if (encodedHash.length > 512 || !encodedHash.startsWith('$argon2id$v=19$')) {
      throw new Error('Encoded Argon2id hash required');
    }
  }
}

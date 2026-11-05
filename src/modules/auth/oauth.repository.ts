import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError } from '../../lib/errors.js';
import type { LockedAuthAccount } from './auth.repository.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { AuthTransaction, GooglePurpose, GoogleIdentityClaims } from './auth.ports.js';
import { AuthEncryption, digestSecret, newSecret } from './crypto.js';
import { isBearerSecret } from './normalization.js';

export const googleFailed = () => new AppError(400, 'GOOGLE_AUTH_FAILED', 'Google authentication failed; start again');
const transactionSchema = z.object({ id: z.string().uuid(), purpose: z.enum(['login', 'link', 'reauthenticate']),
  userId: z.string().uuid().nullable(), sessionId: z.string().uuid().nullable(), securityVersion: z.number().nullable(),
  nonce: z.string(), encryptedVerifier: z.string(), keyId: z.string(), returnPath: z.string() });
export type ClaimedOAuth = z.infer<typeof transactionSchema> & { verifier: string };
const completionSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid(), securityVersion: z.number(),
  purpose: z.enum(['login', 'link', 'reauthenticate']), initiatingUserId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(), initiatingVersion: z.number().nullable(), returnPath: z.string(),
  identity: z.object({ issuer: z.literal('https://accounts.google.com'), subject: z.string().min(1).max(255),
    observedEmail: z.string().nullable(), emailVerified: z.boolean(), displayName: z.string().nullable(), avatarUrl: z.string().nullable(),
    authenticatedAt: z.string().datetime().nullable() }).strict() });

export class OAuthRepository {
  constructor(private readonly auth: AuthRepository, private readonly encryption: AuthEncryption, private readonly environment: string) {}

  async completionUser(ticket: string): Promise<string | null> {
    if (!isBearerSecret(ticket)) throw googleFailed();
    return this.auth.transaction(async transaction => {
      const [row] = await authRows(transaction, sql`select target_user_id as id from auth_private.oauth_completions
        where ticket_digest=${digestSecret('oauth_completion', ticket)} and consumed_at is null and expires_at>clock_timestamp()`,
      z.object({ id: z.string().uuid() }));
      return row?.id ?? null;
    });
  }

  async completion(account: LockedAuthAccount, ticket: string, browserSecret: string) {
    this.auth.assertLocked(account);
    if (!isBearerSecret(browserSecret)) throw googleFailed();
    const [row] = await authRows(account.transaction, sql`select c.id,c.target_user_id as "userId",c.expected_security_version as "securityVersion",
      c.identity,t.purpose,t.initiating_user_id as "initiatingUserId",t.initiating_session_id as "sessionId",
      t.expected_security_version as "initiatingVersion",t.return_path as "returnPath"
      from auth_private.oauth_completions c join auth_private.oauth_transactions t on t.id=c.transaction_id
      join auth_private.browser_contexts b on b.id=t.browser_context_id
      where c.ticket_digest=${digestSecret('oauth_completion', ticket)} and c.target_user_id=${account.user.id}::uuid
      and c.consumed_at is null and c.expires_at>clock_timestamp() and t.status='completed'
      and b.token_digest=${digestSecret('browser_context', browserSecret)} and b.environment=${this.environment}
      and b.expires_at>clock_timestamp() for update of c,t`, completionSchema);
    if (!row || row.securityVersion !== account.user.securityVersion || account.user.status === 'disabled') throw googleFailed();
    return row;
  }

  async consume(account: LockedAuthAccount, id: string): Promise<void> {
    this.auth.assertLocked(account);
    const [consumed] = await authRows(account.transaction, sql`update auth_private.oauth_completions set consumed_at=clock_timestamp()
      where id=${id}::uuid and target_user_id=${account.user.id}::uuid and consumed_at is null and expires_at>clock_timestamp()
      returning id`, z.object({ id: z.string().uuid() }));
    if (!consumed) throw googleFailed();
  }

  async googleForUser(account: LockedAuthAccount): Promise<{ subject: string } | null> {
    this.auth.assertLocked(account);
    const [identity] = await authRows(account.transaction, sql`select subject from auth_private.google_identities
      where user_id=${account.user.id}::uuid for update`, z.object({ subject: z.string() }));
    return identity ?? null;
  }

  async claim(state: string, browserSecret: string): Promise<ClaimedOAuth> {
    if (!isBearerSecret(state) || !isBearerSecret(browserSecret)) throw googleFailed();
    const claimed = await this.auth.transaction(async transaction => {
      const [record] = await authRows(transaction, sql`select t.id,t.purpose,t.initiating_user_id as "userId",
        t.initiating_session_id as "sessionId",t.expected_security_version as "securityVersion",t.nonce,
        t.encrypted_verifier as "encryptedVerifier",t.verifier_key_id as "keyId",t.return_path as "returnPath"
        from auth_private.oauth_transactions t join auth_private.browser_contexts b on b.id=t.browser_context_id
        where t.state_digest=${digestSecret('oauth_state', state)} and b.token_digest=${digestSecret('browser_context', browserSecret)}
        and b.environment=${this.environment} and b.expires_at>clock_timestamp() and t.expires_at>clock_timestamp()
        and t.status='pending' for update of t`, transactionSchema);
      if (!record) throw googleFailed();
      await transaction.execute(sql`update auth_private.oauth_transactions set status='claimed',claimed_at=clock_timestamp(),
        encrypted_verifier=null,verifier_key_id=null where id=${record.id}::uuid`);
      return record;
    });
    // Claim commits before decrypt/exchange; even a lost key requires a fresh attempt.
    return { ...claimed, verifier: this.encryption.decrypt('oauth_pkce', claimed.id,
      { keyId: claimed.keyId, ciphertext: claimed.encryptedVerifier }) };
  }

  fail(id: string): Promise<void> {
    return this.auth.transaction(async transaction => {
      await transaction.execute(sql`update auth_private.oauth_transactions set status='failed',encrypted_verifier=null,verifier_key_id=null
        where id=${id}::uuid and status='claimed'`);
    });
  }

  async identityUser(transaction: AuthTransaction, subject: string): Promise<string | null> {
    const [identity] = await authRows(transaction, sql`select user_id as id from auth_private.google_identities
      where issuer='https://accounts.google.com' and subject=${subject}`, z.object({ id: z.string().uuid() }));
    return identity?.id ?? null;
  }

  async ticket(account: LockedAuthAccount, claimed: ClaimedOAuth, claims: GoogleIdentityClaims): Promise<string> {
    this.auth.assertLocked(account);
    const [updated] = await authRows(account.transaction, sql`update auth_private.oauth_transactions set status='completed'
      where id=${claimed.id}::uuid and status='claimed' and expires_at>clock_timestamp() returning id`, z.object({ id: z.string() }));
    if (!updated || account.user.status === 'disabled') throw googleFailed();
    const secret = newSecret();
    const identity = { ...claims, authenticatedAt: claims.authenticatedAt?.toISOString() ?? null };
    await account.transaction.execute(sql`insert into auth_private.oauth_completions(id,ticket_digest,transaction_id,target_user_id,
      identity,expected_security_version,expires_at) values(${randomUUID()}::uuid,${digestSecret('oauth_completion', secret)},
      ${claimed.id}::uuid,${account.user.id}::uuid,${JSON.stringify(identity)}::jsonb,${account.user.securityVersion},
      clock_timestamp()+${AUTH_POLICY.tokens.completionMs}*interval '1 millisecond')`);
    return secret;
  }

  async create(transaction: AuthTransaction, input: { state: string; nonce: string; verifier: string; purpose: GooglePurpose;
    returnPath: string; browserSecret?: string; initiator?: { userId: string; sessionId: string; securityVersion: number } }) {
    const browserSecret = input.browserSecret ?? newSecret();
    let [browser] = await authRows(transaction, sql`select id,expires_at as "expiresAt" from auth_private.browser_contexts
      where token_digest=${digestSecret('browser_context', browserSecret)} and environment=${this.environment}
      and expires_at>clock_timestamp() for update`, z.object({ id: z.string().uuid(), expiresAt: z.coerce.date() }));
    let secret = browserSecret;
    if (!browser) {
      secret = newSecret();
      [browser] = await authRows(transaction, sql`insert into auth_private.browser_contexts(id,token_digest,csrf_digest,environment,expires_at)
        values(${randomUUID()}::uuid,${digestSecret('browser_context', secret)},${digestSecret('csrf', newSecret())},${this.environment},
          clock_timestamp()+${AUTH_POLICY.tokens.browserContextMs}*interval '1 millisecond') returning id,expires_at as "expiresAt"`,
      z.object({ id: z.string().uuid(), expiresAt: z.coerce.date() }));
    }
    if (!browser) throw new Error('Browser context not created');
    const [outstanding] = await authRows(transaction, sql`select count(*)::int as count from auth_private.oauth_transactions
      where browser_context_id=${browser.id}::uuid and expires_at>clock_timestamp() and status in ('pending','claimed')`, z.object({ count: z.number() }));
    if (outstanding!.count >= AUTH_POLICY.tokens.maxOutstandingOAuth) throw new AppError(429, 'OAUTH_LIMIT', 'Too many Google attempts; try again later');
    const id = randomUUID();
    const encrypted = this.encryption.encrypt('oauth_pkce', id, input.verifier);
    await transaction.execute(sql`insert into auth_private.oauth_transactions(id,state_digest,browser_context_id,purpose,
      initiating_user_id,initiating_session_id,expected_security_version,nonce,encrypted_verifier,verifier_key_id,return_path,expires_at)
      values(${id}::uuid,${digestSecret('oauth_state', input.state)},${browser.id}::uuid,${input.purpose},
        ${input.initiator?.userId ?? null}::uuid,${input.initiator?.sessionId ?? null}::uuid,${input.initiator?.securityVersion ?? null},
        ${input.nonce},${encrypted.ciphertext},${encrypted.keyId},${input.returnPath},
        clock_timestamp()+${AUTH_POLICY.tokens.oauthMs}*interval '1 millisecond')`);
    return { secret, expiresAt: browser.expiresAt, transactionId: id };
  }
}

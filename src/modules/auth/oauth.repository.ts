import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError } from '../../lib/errors.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { AuthTransaction, GooglePurpose } from './auth.ports.js';
import { AuthEncryption, digestSecret, newSecret } from './crypto.js';

export class OAuthRepository {
  constructor(private readonly auth: AuthRepository, private readonly encryption: AuthEncryption, private readonly environment: string) {}

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
    return { secret, expiresAt: browser.expiresAt };
  }
}

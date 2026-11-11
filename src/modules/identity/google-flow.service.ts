import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { googleIdentities, users } from '../../db/schema/index.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { GoogleAttemptStore, type GoogleAttemptBinding } from './google-attempts.js';
import type { GoogleOidc } from './google-oidc.js';
import { googleSignInAccount, invalidGoogleFlow, linkGoogleAccount } from './google-account.js';
import { digest, SessionService } from './session.service.js';

type CallbackOutcome = { completionId: string } | { error: 'retry' | 'canceled' | 'unavailable' };

export class GoogleFlowService {
  constructor(private readonly db: Database, private readonly attempts: GoogleAttemptStore,
    private readonly oidc: GoogleOidc, private readonly sessions: SessionService) {}

  async start(binding: GoogleAttemptBinding) {
    const attempt = await this.attempts.start(binding);
    if (!attempt) throw forbidden('Browser context expired');
    return { authorizationUrl: this.oidc.authorizationUrl(attempt) };
  }

  async callback(binding: GoogleAttemptBinding, input: { state: string; code?: string; error?: string }): Promise<CallbackOutcome> {
    const claim = await this.attempts.claim(binding, input.state);
    if (!claim) return { error: 'retry' };
    if (!input.code || input.error) {
      await this.attempts.finish(binding, claim, null);
      return { error: input.error === 'access_denied' && !input.code ? 'canceled' : 'retry' };
    }

    try {
      const identity = await this.oidc.exchange(input.code, claim);
      let observedLink = null;
      if (binding.purpose === 'sign_in') {
        const [link] = await this.db.select({ userId: users.id, revision: users.googleLinkRevision })
          .from(googleIdentities).innerJoin(users, eq(users.id, googleIdentities.userId))
          .where(and(eq(googleIdentities.issuer, identity.issuer), eq(googleIdentities.subject, identity.subject)));
        observedLink = link ?? null;
      }
      const completionId = await this.attempts.finish(binding, claim, { identity, observedLink });
      return completionId ? { completionId } : { error: 'retry' };
    } catch (error) {
      await this.attempts.finish(binding, claim, null);
      return { error: error instanceof AppError && error.statusCode < 500 ? 'retry' : 'unavailable' };
    }
  }

  async completeSignIn(binding: Extract<GoogleAttemptBinding, { purpose: 'sign_in' }>, completionId: string, platform: string) {
    const result = await this.attempts.consume(binding, completionId, async (tx, proof) => {
      try {
        // A savepoint rolls back a losing signup without making the proof reusable.
        return await tx.transaction(async (accountTx) => {
          const { account, outcome } = await googleSignInAccount(accountTx, proof);
          const issued = await this.sessions.insert(accountTx, account, new Date(), 'google', platform);
          await this.sessions.consumeContext(accountTx, digest(binding.contextSecret));
          return { ...issued, outcome };
        });
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) return error;
        throw error;
      }
    });
    if (!result) throw invalidGoogleFlow();
    if (result instanceof AppError) throw result;
    return result;
  }

  async completeLink(binding: Extract<GoogleAttemptBinding, { purpose: 'link' }>, completionId: string) {
    const result = await this.attempts.consume(binding, completionId, (tx, proof) =>
      linkGoogleAccount(tx, binding.session.userId, proof.identity));
    if (!result) throw invalidGoogleFlow();
    if (result instanceof AppError) throw result;
    return result;
  }
}

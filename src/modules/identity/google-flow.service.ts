import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { googleIdentities, users } from '../../db/schema/index.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { GoogleAttemptStore, type GoogleAttemptBinding } from './google-attempts.js';
import type { GoogleOidc } from './google-oidc.js';

export const GOOGLE_OIDC = Symbol('GOOGLE_OIDC');

type CallbackOutcome = { completionId: string } | { error: 'retry' | 'canceled' | 'unavailable' };

export class GoogleFlowService {
  constructor(private readonly db: Database, private readonly attempts: GoogleAttemptStore, private readonly oidc: GoogleOidc) {}

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
}

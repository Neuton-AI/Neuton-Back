import { calculatePKCECodeChallenge } from 'openid-client';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { AuthRepository } from './auth.repository.js';
import { GoogleOidcClient } from './auth.ports.js';
import type { AuthRequestContext } from './account.service.js';
import { OAuthRepository } from './oauth.repository.js';
import { SessionRepository } from './session.repository.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { newSecret } from './crypto.js';

export const googleStartInput = z.object({ purpose: z.enum(['login', 'link', 'reauthenticate']),
  returnPath: z.string().refine(path => (AUTH_POLICY.returnPaths as readonly string[]).includes(path)).default('/') }).strict();

export function requireRecentAuthentication(session: { recentAuthenticatedAt: Date | null }): void {
  const recent = session.recentAuthenticatedAt?.getTime();
  if (!recent || recent < Date.now() - AUTH_POLICY.session.recentAuthenticationMs || recent > Date.now() + 60_000) {
    throw new AppError(403, 'REAUTHENTICATION_REQUIRED', 'Authenticate again to continue');
  }
}

export class GoogleLoginService {
  constructor(private readonly auth: AuthRepository, private readonly oauth: OAuthRepository,
    private readonly sessions: SessionRepository, private readonly protocol: GoogleOidcClient, private readonly limits: AuthRateLimits) {}

  async start(body: unknown, browser: { browserSecret?: string; sessionSecret?: string }, context: AuthRequestContext) {
    const input = googleStartInput.parse(body);
    await this.limits.oauthStart(context.ip);
    const state = newSecret();
    const nonce = newSecret();
    const verifier = newSecret();
    // Discovery/network work is deliberately outside account locks and SQL transactions.
    const authorizationUrl = await this.protocol.authorizationUrl({ ...input, state, nonce,
      codeChallenge: await calculatePKCECodeChallenge(verifier) });
    const create = { ...input, state, nonce, verifier, browserSecret: browser.browserSecret };
    if (input.purpose === 'login') {
      const bound = await this.auth.transaction(transaction => this.oauth.create(transaction, create));
      return { authorizationUrl, browser: bound };
    }
    if (!browser.sessionSecret) throw unauthorized();
    const bound = await this.sessions.withSession(browser.sessionSecret, async (account, session) => {
      if (session.status !== 'active' || !account.user.emailConfirmedAt) throw forbidden('Confirm your email before managing Google sign-in');
      if (input.purpose === 'link') requireRecentAuthentication(session);
      return this.oauth.create(account.transaction, { ...create, initiator: { userId: account.user.id,
        sessionId: session.id, securityVersion: account.user.securityVersion } });
    });
    if (!bound) throw unauthorized();
    return { authorizationUrl, browser: bound };
  }
}

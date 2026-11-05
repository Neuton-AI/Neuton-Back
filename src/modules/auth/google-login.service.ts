import { calculatePKCECodeChallenge } from 'openid-client';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { AuthRepository } from './auth.repository.js';
import { GoogleOidcClient } from './auth.ports.js';
import type { AuthRequestContext } from './account.service.js';
import { OAuthRepository, googleFailed } from './oauth.repository.js';
import { SessionRepository } from './session.repository.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { newSecret } from './crypto.js';
import { AccountRepository } from './account.repository.js';
import { ActionTokenRepository } from './action-token.repository.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { SecurityEvents } from './security-events.js';
import { normalizeEmail } from './normalization.js';
import type { LockedAuthAccount } from './auth.repository.js';
import type { GoogleIdentityClaims } from './auth.ports.js';
import type { ClaimedOAuth } from './oauth.repository.js';

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
    private readonly sessions: SessionRepository, private readonly protocol: GoogleOidcClient, private readonly limits: AuthRateLimits,
    private readonly accounts: AccountRepository, private readonly actions: ActionTokenRepository,
    private readonly outbox: MailOutboxRepository, private readonly events: SecurityEvents, private readonly origin: string) {}

  async complete(ticket: string, browserSecret: string | undefined, sessionSecret: string | undefined, context: AuthRequestContext) {
    if (!browserSecret) throw googleFailed();
    const userId = await this.oauth.completionUser(ticket);
    if (!userId) throw googleFailed();
    // Resolve presented cookie before locking; revalidate its exact record under the user lock below.
    const presented = sessionSecret ? await this.sessions.resolve(sessionSecret) : null;
    const result = await this.auth.withUser(userId, async account => {
      const completion = await this.oauth.completion(account, ticket, browserSecret);
      const { identity, purpose } = completion;
      let replaceSessionId: string | undefined;
      if (purpose !== 'login') {
        if (!presented || presented.userId !== userId || presented.id !== completion.sessionId ||
          completion.initiatingUserId !== userId || completion.initiatingVersion !== account.user.securityVersion) throw googleFailed();
        const current = await this.sessions.current(account, presented.id);
        if (!current || current.status !== 'active' || !account.user.emailConfirmedAt) throw googleFailed();
        replaceSessionId = current.id;
        if (purpose === 'link') requireRecentAuthentication(current);
      }
      const mapped = await this.oauth.identityUser(account.transaction, identity.subject);
      if (purpose === 'link') {
        if (mapped && mapped !== userId) throw new AppError(409, 'GOOGLE_ALREADY_LINKED', 'This Google account is already linked');
        const existing = await this.oauth.googleForUser(account);
        if (existing) throw new AppError(409, 'GOOGLE_ALREADY_LINKED', 'A Google account is already linked');
        await this.insertIdentity(account, { ...identity, authenticatedAt: null });
      } else if (mapped !== userId) throw googleFailed();
      let recentAuthenticatedAt: Date | null = null;
      if (purpose === 'reauthenticate') {
        recentAuthenticatedAt = identity.authenticatedAt ? new Date(identity.authenticatedAt) : null;
        if (!recentAuthenticatedAt || recentAuthenticatedAt.getTime() < Date.now() - AUTH_POLICY.session.recentAuthenticationMs ||
          recentAuthenticatedAt.getTime() > Date.now() + 60_000) throw googleFailed();
      }
      await this.oauth.consume(account, completion.id);
      if (purpose === 'link') {
        await this.auth.invalidateSecurityState(account, 'google_linked');
        await this.outbox.enqueueNotice(account, 'google_linked');
        replaceSessionId = undefined;
      }
      const fresh = await this.auth.lockUser(account.transaction, userId);
      if (!fresh) throw googleFailed();
      const session = await this.sessions.issue(fresh, { method: 'google', recentAuthenticatedAt },
        { ip: context.ip, userAgent: context.userAgent }, replaceSessionId);
      await account.transaction.execute(sql`update auth_private.google_identities set last_login_at=clock_timestamp()
        where user_id=${userId}::uuid and subject=${identity.subject}`);
      await this.events.append(account.transaction, { event: 'google_completed', result: 'success', correlationId: context.traceId,
        actorUserId: userId, sessionId: session.sessionId, metadata: { method: 'google' } });
      return { session, returnPath: completion.returnPath, purpose };
    });
    if (!result) throw googleFailed();
    return result;
  }

  async callback(url: URL, browserSecret: string | undefined, context: AuthRequestContext): Promise<string> {
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || !browserSecret) throw googleFailed();
    const claimed = await this.oauth.claim(states[0]!, browserSecret);
    try {
      if (url.searchParams.has('error')) throw googleFailed();
      const claims = await this.protocol.exchange({ callbackUrl: url, state: states[0]!, nonce: claimed.nonce,
        verifier: claimed.verifier, purpose: claimed.purpose });
      const ticket = await this.mapIdentity(claimed, claims, context);
      const redirect = new URL('/auth/google/complete', this.origin);
      redirect.hash = `ticket=${ticket}`;
      return redirect.href;
    } catch (error) {
      await this.oauth.fail(claimed.id);
      if (error instanceof AppError) throw error;
      throw googleFailed();
    }
  }

  private async mapIdentity(claimed: ClaimedOAuth, claims: GoogleIdentityClaims, context: AuthRequestContext): Promise<string> {
    const mapped = await this.auth.transaction(transaction => this.oauth.identityUser(transaction, claims.subject));
    if (claimed.purpose !== 'login') {
      if (!claimed.userId) throw googleFailed();
      const ticket = await this.auth.withUser(claimed.userId, async account => {
        const session = await this.sessions.current(account, claimed.sessionId!);
        if (!session || account.user.securityVersion !== claimed.securityVersion || session.status !== 'active') throw googleFailed();
        if (claimed.purpose === 'reauthenticate' && (mapped !== account.user.id || !claims.authenticatedAt)) throw googleFailed();
        if (claimed.purpose === 'link') {
          requireRecentAuthentication(session);
          if (mapped && mapped !== account.user.id) throw new AppError(409, 'GOOGLE_ALREADY_LINKED', 'This Google account is already linked');
        }
        return this.oauth.ticket(account, claimed, claims);
      });
      if (!ticket) throw googleFailed();
      return ticket;
    }
    if (mapped) {
      const ticket = await this.auth.withUser(mapped, account => this.oauth.ticket(account, claimed, claims));
      if (!ticket) throw googleFailed();
      return ticket;
    }
    if (!claims.observedEmail || !claims.emailVerified) throw googleFailed();
    const email = normalizeEmail(claims.observedEmail);
    return this.auth.transaction(async transaction => {
      const account = await this.accounts.createPending(transaction, { email: email.display,
        fullName: claims.displayName ?? undefined, avatarUrl: claims.avatarUrl ?? undefined });
      if (!account) throw new AppError(400, 'GOOGLE_EMAIL_COLLISION', 'Sign in with your existing method, then link Google in account settings');
      await this.insertIdentity(account, claims);
      const action = await this.actions.issue(account, 'confirm_email', email.normalized);
      await this.outbox.enqueueAction(account, action);
      await this.events.append(transaction, { event: 'registration_requested', result: 'success', correlationId: context.traceId,
        subjectUserId: account.user.id, metadata: { method: 'google', oauthTransactionId: claimed.id } });
      return this.oauth.ticket(account, claimed, claims);
    });
  }

  private async insertIdentity(account: LockedAuthAccount, claims: GoogleIdentityClaims): Promise<void> {
    await account.transaction.execute(sql`insert into auth_private.google_identities(id,user_id,issuer,subject,observed_email)
      values(${randomUUID()}::uuid,${account.user.id}::uuid,${claims.issuer},${claims.subject},${claims.observedEmail})`);
  }

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

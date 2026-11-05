import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { assertExpectedUser } from '../identity/expected-user.js';
import type { AuthRequestContext } from './account.service.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { LockedAuthAccount } from './auth.repository.js';
import type { PasswordHasher } from './auth.ports.js';
import { SessionRepository } from './session.repository.js';
import type { SessionRecord } from './session.types.js';
import { requireRecentAuthentication } from './google-login.service.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { SecurityEvents } from './security-events.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { validatePassword } from './normalization.js';

export class MethodsService {
  constructor(private readonly auth: AuthRepository, private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher, private readonly outbox: MailOutboxRepository,
    private readonly events: SecurityEvents, private readonly limits: AuthRateLimits) {}

  private async locked<T>(secret: string, expectedUserId: string | string[] | undefined,
    work: (account: LockedAuthAccount, session: SessionRecord) => Promise<T>): Promise<T> {
    const result = await this.sessions.withSession(secret, async (account, session) => {
      assertExpectedUser(expectedUserId, account.user.id);
      if (session.status !== 'active' || !account.user.emailConfirmedAt) throw forbidden('Confirm your email before managing sign-in methods');
      return work(account, session);
    });
    if (!result) throw unauthorized();
    return result;
  }

  private async available(account: LockedAuthAccount) {
    const [methods] = await authRows(account.transaction, sql`select
      exists(select 1 from auth_private.password_credentials where user_id=${account.user.id}::uuid) as password,
      exists(select 1 from auth_private.google_identities where user_id=${account.user.id}::uuid) as google`,
    z.object({ password: z.boolean(), google: z.boolean() }));
    return methods!;
  }

  list(secret: string, expectedUserId?: string | string[]) {
    return this.locked(secret, expectedUserId, async (account, session) => {
      const methods = await this.available(account);
      const recentAt = session.recentAuthenticatedAt?.getTime() ?? 0;
      const recent = recentAt > Date.now() - AUTH_POLICY.session.recentAuthenticationMs && recentAt <= Date.now() + 60_000;
      return { passwordAvailable: methods.password, googleLinked: methods.google,
        capabilities: { linkGoogle: !methods.google && recent, unlinkGoogle: methods.google && methods.password && recent,
          addPassword: methods.google && !methods.password && session.authenticationMethod === 'google' && recent,
          reauthenticateGoogle: methods.google } };
    });
  }

  async addPassword(secret: string, password: string, context: AuthRequestContext, expectedUserId?: string | string[]) {
    validatePassword(password);
    await this.limits.global();
    await this.locked(secret, expectedUserId, async (account, session) => this.requireAddition(account, session));
    const encodedHash = await this.hasher.hash(password);
    return this.locked(secret, expectedUserId, async (account, session) => {
      await this.requireAddition(account, session);
      await account.transaction.execute(sql`insert into auth_private.password_credentials(user_id,encoded_hash)
        values(${account.user.id}::uuid,${encodedHash})`);
      return this.transition(account, session, 'password_added', context);
    });
  }

  private async requireAddition(account: LockedAuthAccount, session: SessionRecord): Promise<true> {
    const methods = await this.available(account);
    if (methods.password) throw new AppError(409, 'PASSWORD_ALREADY_EXISTS', 'Use password change to replace your existing password');
    if (!methods.google || session.authenticationMethod !== 'google') throw forbidden('Verify your linked Google account first');
    requireRecentAuthentication(session);
    return true;
  }

  unlinkGoogle(secret: string, context: AuthRequestContext, expectedUserId?: string | string[]) {
    return this.locked(secret, expectedUserId, async (account, session) => {
      const methods = await this.available(account);
      requireRecentAuthentication(session);
      if (!methods.google) throw new AppError(409, 'GOOGLE_NOT_LINKED', 'Google sign-in is not linked');
      if (!methods.password) throw new AppError(409, 'LAST_LOGIN_METHOD', 'Add a password before removing Google sign-in');
      await account.transaction.execute(sql`delete from auth_private.google_identities where user_id=${account.user.id}::uuid`);
      return this.transition(account, session, 'google_unlinked', context);
    });
  }

  private async transition(account: LockedAuthAccount, previous: SessionRecord, event: 'password_added' | 'google_unlinked', context: AuthRequestContext) {
    await this.auth.invalidateSecurityState(account, event);
    await this.outbox.enqueueNotice(account, event);
    const fresh = await this.auth.lockUser(account.transaction, account.user.id);
    if (!fresh) throw unauthorized();
    const method = event === 'password_added' ? 'password' : previous.authenticationMethod;
    const session = await this.sessions.issue(fresh, { method, recentAuthenticatedAt: previous.recentAuthenticatedAt },
      { ip: context.ip, userAgent: context.userAgent });
    await this.events.append(account.transaction, { event, result: 'success', correlationId: context.traceId,
      actorUserId: account.user.id, sessionId: session.sessionId });
    return session;
  }
}

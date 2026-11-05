import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { ActionTokenRepository } from './action-token.repository.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { SecurityEvents } from './security-events.js';
import type { PasswordHasher } from './auth.ports.js';
import type { registrationInput } from './contracts.js';
import { invalidAction } from './auth-errors.js';
import { SessionRepository } from './session.repository.js';
import { requireRecentAuthentication } from './google-login.service.js';
import { normalizeEmail } from './normalization.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { assertExpectedUser } from '../identity/expected-user.js';
import type { LockedAuthAccount } from './auth.repository.js';

export interface AuthRequestContext { ip: string; traceId: string; userAgent?: string }
export class AccountService {
  constructor(private readonly auth: AuthRepository, private readonly accounts: AccountRepository,
    private readonly actions: ActionTokenRepository, private readonly outbox: MailOutboxRepository,
    private readonly hasher: PasswordHasher, private readonly limits: AuthRateLimits, private readonly events: SecurityEvents,
    private readonly sessions: SessionRepository) {}

  private async withRecentAccount<T>(secret: string, expectedUserId: string | string[] | undefined,
    work: (account: LockedAuthAccount) => Promise<T>): Promise<T> {
    const result = await this.sessions.withSession(secret, async (account, session) => {
      assertExpectedUser(expectedUserId, account.user.id);
      if (account.user.status !== 'active' || !account.user.emailConfirmedAt) throw forbidden('Confirm your contact email first');
      requireRecentAuthentication(session);
      return { value: await work(account) };
    });
    if (!result) throw unauthorized();
    return result.value;
  }

  async changeEmail(secret: string, destination: string, context: AuthRequestContext, expectedUserId?: string | string[]): Promise<void> {
    const email = normalizeEmail(destination);
    const permitted = await this.limits.email(context.ip, email.normalized);
    await this.withRecentAccount(secret, expectedUserId, async account => {
      if (email.normalized === account.user.normalizedEmail) throw new AppError(409, 'EMAIL_UNCHANGED', 'Enter a different contact email');
      if (!permitted) return;
      const action = await this.actions.issue(account, 'email_change', email.normalized);
      await this.outbox.enqueueAction(account, action);
      await this.events.append(account.transaction, { event: 'email_change_requested', result: 'success', correlationId: context.traceId,
        actorUserId: account.user.id });
    });
  }

  async confirmEmailChange(secret: string, token: string, context: AuthRequestContext, expectedUserId?: string | string[]): Promise<void> {
    await this.limits.global();
    const target = await this.actions.find('email_change', token);
    if (!target?.intendedEmail) throw invalidAction();
    try {
      await this.withRecentAccount(secret, expectedUserId, async account => {
        if (target.userId !== account.user.id) throw new AppError(409, 'ACCOUNT_CHANGED', 'Sign in to the account that requested this change');
        const consumed = await this.actions.consume(account, { purpose: 'email_change', secret: token, intendedEmail: target.intendedEmail! });
        if (!consumed) throw invalidAction();
        // The unique index arbitrates concurrent registrations and confirmations for the destination.
        await account.transaction.execute(sql`update auth_private.users set email=${target.intendedEmail},normalized_email=${target.intendedEmail},
          email_confirmed_at=clock_timestamp(),updated_at=clock_timestamp() where id=${account.user.id}::uuid`);
        await this.auth.invalidateSecurityState(account, 'email_changed');
        await this.outbox.enqueueNotice(account, 'email_changed', account.user.normalizedEmail);
        await this.outbox.enqueueNotice(account, 'email_changed');
        await this.events.append(account.transaction, { event: 'email_changed', result: 'success', correlationId: context.traceId,
          actorUserId: account.user.id });
      });
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; cause && typeof cause === 'object' && depth < 5; depth += 1) {
        if ('code' in cause && cause.code === '23505') throw new AppError(409, 'EMAIL_UNAVAILABLE', 'This contact email is unavailable');
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      throw error;
    }
  }

  async register(input: z.infer<typeof registrationInput>, context: AuthRequestContext): Promise<void> {
    if (!(await this.limits.email(context.ip, input.email.normalized))) return;
    const encodedHash = await this.hasher.hash(input.password);
    await this.auth.transaction(async transaction => {
      const account = await this.accounts.createPending(transaction, { email: input.email.display, fullName: input.fullName, encodedHash });
      if (account) {
        const action = await this.actions.issue(account, 'confirm_email', account.user.normalizedEmail);
        await this.outbox.enqueueAction(account, action);
      }
      await this.events.append(transaction, { event: 'registration_requested', result: 'success', correlationId: context.traceId });
    });
  }

  async resend(normalizedEmail: string, context: AuthRequestContext): Promise<void> {
    if (!(await this.limits.email(context.ip, normalizedEmail))) return;
    const id = await this.accounts.findIdByEmail(normalizedEmail);
    if (!id) return;
    await this.auth.withUser(id, async account => {
      if (account.user.status !== 'pending_email' || account.user.normalizedEmail !== normalizedEmail) return;
      const token = await this.actions.issue(account, 'confirm_email', account.user.normalizedEmail);
      await this.outbox.enqueueAction(account, token);
      await this.events.append(account.transaction, { event: 'confirmation_requested', result: 'success', correlationId: context.traceId,
        subjectUserId: id });
    });
  }

  async confirm(secret: string, context: AuthRequestContext): Promise<void> {
    await this.limits.global();
    const target = await this.actions.find('confirm_email', secret);
    if (!target) throw invalidAction();
    const confirmed = await this.auth.withUser(target.userId, async account => {
      if (!(await this.actions.consume(account, { purpose: 'confirm_email', secret }))) return false;
      await account.transaction.execute(sql`update auth_private.users set status='active',email_confirmed_at=clock_timestamp(),updated_at=clock_timestamp()
        where id=${account.user.id}::uuid and status='pending_email'`);
      // A pending session must never silently become a full business session after confirmation.
      await this.auth.invalidateSecurityState(account, 'email_confirmed');
      await this.events.append(account.transaction, { event: 'email_confirmed', result: 'success', correlationId: context.traceId,
        subjectUserId: account.user.id });
      return true;
    });
    if (!confirmed) throw invalidAction();
  }
}

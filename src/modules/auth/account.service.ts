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

export interface AuthRequestContext { ip: string; traceId: string; userAgent?: string }
export class AccountService {
  constructor(private readonly auth: AuthRepository, private readonly accounts: AccountRepository,
    private readonly actions: ActionTokenRepository, private readonly outbox: MailOutboxRepository,
    private readonly hasher: PasswordHasher, private readonly limits: AuthRateLimits, private readonly events: SecurityEvents) {}

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

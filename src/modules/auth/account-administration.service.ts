import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { AuthRepository } from './auth.repository.js';
import { SecurityEvents } from './security-events.js';

/** Operator-only composition; deliberately absent from AuthModule and all public controllers. */
export class AccountAdministrationService {
  constructor(private readonly auth: AuthRepository, private readonly events: SecurityEvents) {}

  async disable(userId: string, correlationId: string): Promise<boolean> {
    z.string().uuid().parse(userId);
    z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(correlationId);
    const result = await this.auth.withUser(userId, async account => {
      if (account.user.status === 'disabled') return false;
      await account.transaction.execute(sql`update auth_private.users set status='disabled',updated_at=clock_timestamp()
        where id=${account.user.id}::uuid`);
      await this.auth.invalidateSecurityState(account, 'account_disabled');
      await this.events.append(account.transaction, { event: 'account_disabled', result: 'success', correlationId,
        subjectUserId: account.user.id, metadata: { reason: 'disabled' } });
      return true;
    });
    if (result === null) throw notFound('Account not found');
    return result;
  }
}

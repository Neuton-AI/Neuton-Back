import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthTransaction } from './auth.ports.js';

const metadataSchema = z.object({
  method: z.enum(['password', 'google']).optional(),
  reason: z.enum(['invalid_credentials', 'expired', 'used', 'rate_limited', 'dependency_unavailable',
    'csrf_invalid', 'disabled', 'conflict', 'revoked', 'denied']).optional(),
  affectedSessions: z.number().int().min(0).max(1_000_000).optional(),
  actionId: z.string().uuid().optional(), oauthTransactionId: z.string().uuid().optional(),
  mailId: z.string().uuid().optional(), shopId: z.string().uuid().optional(),
}).strict();
const eventSchema = z.object({
  event: z.enum(['registration_requested', 'email_confirmed', 'confirmation_requested', 'login', 'logout', 'logout_all',
    'session_revoked', 'session_renewed', 'password_recovery_requested', 'password_reset', 'password_changed',
    'password_added', 'reauthenticated', 'google_started', 'google_completed', 'google_linked', 'google_unlinked',
    'email_change_requested', 'email_changed', 'account_disabled', 'mail_dispatched', 'mail_discarded', 'csrf_rejected', 'rate_limited']),
  result: z.enum(['success', 'denied', 'failed']), correlationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  actorUserId: z.string().uuid().nullable().optional(), subjectUserId: z.string().uuid().nullable().optional(),
  sessionId: z.string().uuid().nullable().optional(), metadata: metadataSchema.default({}),
}).strict();
export type SecurityEventInput = z.input<typeof eventSchema>;

export class SecurityEvents {
  /** Use the originating account transaction; no detached best-effort writes for successful transitions. */
  async append(transaction: AuthTransaction, input: unknown): Promise<void> {
    const event = eventSchema.parse(input);
    await transaction.execute(sql`insert into auth_private.security_events
      (event,result,correlation_id,actor_user_id,subject_user_id,session_id,metadata)
      values(${event.event},${event.result},${event.correlationId},${event.actorUserId ?? null}::uuid,
        ${event.subjectUserId ?? null}::uuid,${event.sessionId ?? null}::uuid,${JSON.stringify(event.metadata)}::jsonb)`);
  }
}

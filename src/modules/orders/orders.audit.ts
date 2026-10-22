import { Injectable } from '@nestjs/common';
import { recordAudit, type AuditInput } from '../../lib/audit.js';
import type { ActorContext } from '../identity/contracts.js';
/** Audit is best effort after commit; a failed audit never reverses a successful order mutation. */
@Injectable()
export class OrdersAudit {
  async record(actor: ActorContext, input: AuditInput): Promise<void> {
    try {
      await recordAudit(input);
    } catch {
      actor.log.error({
        event: 'order_audit_failed', eventType: input.eventType, resourceId: input.resourceId
      }, 'audit write failed');
    }
  }
}

import { Injectable } from '@nestjs/common';
import { recordAudit, type AuditInput } from './audit.js';
import type { ActorContext } from '../modules/identity/contracts.js';

/** Best-effort audit writes run after the owning business transaction commits. */
@Injectable()
export class DomainAudit {
  async record(actor: ActorContext, input: AuditInput): Promise<void> {
    try {
      await recordAudit(input);
    } catch {
      actor.log.error({ event: 'catalog_audit_failed', eventType: input.eventType,
        resourceId: input.resourceId }, 'audit write failed');
    }
  }
}

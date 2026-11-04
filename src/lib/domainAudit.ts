import { Injectable } from '@nestjs/common';
import { recordAudit, type AuditInput } from './audit.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import type { ShopTransaction } from '../db/types.js';
/** Audit failure rolls back the owning business operation. */
@Injectable()
export class DomainAudit {
  async record(actor: ActorContext, input: AuditInput, scope: ShopTransaction): Promise<void> {
    await recordAudit({ ...input, ipAddress: actor.ipAddress }, scope);
  }
}

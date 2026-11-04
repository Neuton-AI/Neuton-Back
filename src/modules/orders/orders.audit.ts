import { Injectable } from '@nestjs/common';
import { recordAudit, type AuditInput } from '../../lib/audit.js';
import type { ActorContext } from '../identity/contracts.js';
import type { ShopTransaction } from '../../db/types.js';
/** Order history commits atomically with the business mutation. */
@Injectable()
export class OrdersAudit {
  async record(actor: ActorContext, input: AuditInput, scope: ShopTransaction): Promise<void> {
    await recordAudit({ ...input, ipAddress: actor.ipAddress }, scope);
  }
}

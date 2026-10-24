import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { recordAudit, type AuditInput } from '../../lib/audit.js';
import {
  ReceiptsPersistence,
  type ReceiptTransaction,
} from './receipts.persistence.js';
import type {
  ReceiptQuery,
  ReceiptPatchInput,
  ReceiptStatusDto,
  VerifyReceiptInput,
} from './contracts.js';

export const RECEIPTS_COMMIT_EFFECTS = Symbol('RECEIPTS_COMMIT_EFFECTS');
export const RECEIPTS_AUDIT = Symbol('RECEIPTS_AUDIT');
export type ReceiptAfterCommit = (effect: () => Promise<void>) => void;
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(ReceiptsPersistence)
    private readonly persistence: ReceiptsPersistence,
    @Optional()
    @Inject(RECEIPTS_COMMIT_EFFECTS)
    private readonly afterCommit?: ReceiptAfterCommit,
    @Optional() @Inject(RECEIPTS_AUDIT)
    private readonly record: typeof recordAudit = recordAudit,
  ) {}
  inTransaction(tx: ReceiptTransaction, afterCommit: ReceiptAfterCommit) {
    return new ReceiptsService(new ReceiptsPersistence(tx), afterCommit, this.record);
  }
  private async audit(
    actor: ActorContext,
    input: Omit<AuditInput, 'shopId' | 'userId' | 'ipAddress'>,
  ) {
    const effect = async () => {
      try {
        await this.record({
          ...input,
          shopId: actor.shop.id,
          userId: actor.user.id,
          ipAddress: actor.ipAddress,
        });
      } catch {
        actor.log.error(
          { event: 'receipt_audit_failed', eventType: input.eventType },
          'audit write failed',
        );
      }
      actor.log.info(
        { event: input.eventType.toLowerCase(), receiptId: input.resourceId },
        'receipt operation committed',
      );
    };
    if (this.afterCommit) this.afterCommit(effect);
    else await effect();
  }
  async list(actor: ActorContext, query: ReceiptQuery) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { receipts: await this.persistence.list(actor.shop.id, query) };
  }
  async detail(actor: ActorContext, id: string) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { receipt: await this.persistence.detail(actor.shop.id, id) };
  }
  async status(actor: ActorContext, id: string): Promise<ReceiptStatusDto> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.status(actor.shop.id, id);
  }
  async pending(actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { pending: await this.persistence.pending(actor.shop.id) };
  }
  async edit(actor: ActorContext, id: string, input: ReceiptPatchInput) {
    requireActorRole(actor, ['owner', 'admin']);
    const receipt = await this.persistence.edit(actor.shop.id, id, input);
    await this.audit(actor, { eventType: 'RECEIPT_UPDATED', resourceId: id });
    return { receipt };
  }
  async verify(actor: ActorContext, id: string, input: VerifyReceiptInput) {
    requireActorRole(actor, ['owner', 'admin']);
    const outcome = await this.persistence.verify(
      actor.shop.id,
      actor.user.id,
      id,
      input,
    );
    await this.audit(actor, {
      eventType: 'RECEIPT_PROCESSED',
      resourceId: id,
      metadata: { accepted: outcome.accepted, rejected: outcome.rejected },
    });
    return outcome;
  }
  async delete(actor: ActorContext, id: string): Promise<{ ok: true }> {
    requireActorRole(actor, ['owner', 'admin']);
    await this.persistence.delete(actor.shop.id, id, actor.traceId);
    await this.audit(actor, { eventType: 'RECEIPT_DELETED', resourceId: id });
    return { ok: true };
  }
}

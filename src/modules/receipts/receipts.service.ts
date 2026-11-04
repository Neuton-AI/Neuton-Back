import type { AfterShopCommit } from '../../db/shop-operation.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { recordAudit, type AuditInput } from '../../lib/audit.js';
import type { ShopTransaction } from '../../db/types.js';
import {
  ReceiptsPersistence,
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
  inTransaction(tx: ShopTransaction, afterCommit: ReceiptAfterCommit) {
    return new ReceiptsService(new ReceiptsPersistence(tx), afterCommit, this.record);
  }
  private async audit(
    actor: ActorContext,
    scope: ShopTransaction,
    input: Omit<AuditInput, 'shopId' | 'userId' | 'ipAddress'>,
    operationAfterCommit?: AfterShopCommit,
  ) {
    await this.record({
      ...input,
      shopId: actor.shop.id,
      userId: actor.user.id,
      ipAddress: actor.ipAddress,
    }, scope);
    const effect = async () => {
      actor.log.info(
        { event: input.eventType.toLowerCase(), receiptId: input.resourceId },
        'receipt operation committed',
      );
    };
    const defer = operationAfterCommit ?? this.afterCommit;
    if (defer) defer(effect);
    else await effect();
  }
  async list(actor: ActorContext, query: ReceiptQuery) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      return { receipts: await persistence.list(actor.shop.id, query) };
    });
  }
  async detail(actor: ActorContext, id: string) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      return { receipt: await persistence.detail(actor.shop.id, id) };
    });
  }
  async status(actor: ActorContext, id: string): Promise<ReceiptStatusDto> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      return persistence.status(actor.shop.id, id);
    });
  }
  async pending(actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      return { pending: await persistence.pending(actor.shop.id) };
    });
  }
  async edit(actor: ActorContext, id: string, input: ReceiptPatchInput) {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      const receipt = await persistence.edit(actor.shop.id, id, input);
      await this.audit(actor, persistence.scope, { eventType: 'RECEIPT_UPDATED', resourceId: id }, operationAfterCommit);
      return { receipt };
    });
  }
  async verify(actor: ActorContext, id: string, input: VerifyReceiptInput) {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      const outcome = await persistence.verify(
        actor.shop.id,
        actor.user.id,
        id,
        input,
      );
      await this.audit(actor, persistence.scope, {
        eventType: 'RECEIPT_PROCESSED',
        resourceId: id,
        metadata: { accepted: outcome.accepted, rejected: outcome.rejected },
      }, operationAfterCommit);
      return outcome;
    });
  }
  async delete(actor: ActorContext, id: string): Promise<{ ok: true }> {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      await persistence.delete(actor.shop.id, id, actor.traceId);
      await this.audit(actor, persistence.scope, { eventType: 'RECEIPT_DELETED', resourceId: id }, operationAfterCommit);
      return { ok: true };
    });
  }
}

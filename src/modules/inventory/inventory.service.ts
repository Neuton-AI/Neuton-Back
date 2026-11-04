import type { AfterShopCommit } from '../../db/shop-operation.js';
import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { DomainAudit } from '../../lib/domainAudit.js';
import { toNumber } from '../../lib/money.js';
import { InventoryPersistence } from './inventory.persistence.js';
import type { InventoryInput, InventoryPatchInput, InventoryQuery, InventoryDto } from './contracts.js';
import type { inventoryAdjustmentSchema } from '../../lib/inventoryAdjustments.js';
import type { z } from 'zod';
import type { ShopTransaction } from '../../db/types.js';
@Injectable()
export class InventoryService {
  constructor(
    @Inject(InventoryPersistence) private readonly persistence: InventoryPersistence,
    @Inject(DomainAudit) private readonly audit: DomainAudit = new DomainAudit(),
  ) {}

  async createInventory(actor: ActorContext, input: InventoryInput) {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      const item = await persistence.create(actor.shop.id, input);
      await this.inventoryAudit(actor, persistence.scope, item.id, {
        action: 'create',
        name: input.name,
      }, operationAfterCommit);
      return { item };
    });
  }
  async editInventory(
    actor: ActorContext,
    id: string,
    input: InventoryPatchInput,
  ) {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      const item = await persistence.edit(actor.shop.id, id, input);
      await this.inventoryAudit(actor, persistence.scope, id, undefined, operationAfterCommit);
      return { item };
    });
  }
  async deactivateInventory(
    actor: ActorContext,
    id: string,
  ): Promise<{ ok: true }> {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      await persistence.deactivate(actor.shop.id, id);
      return { ok: true };
    });
  }
  private async inventoryAudit(
    actor: ActorContext,
    scope: ShopTransaction,
    id: string,
    metadata: Record<string, unknown> | undefined,
    operationAfterCommit?: AfterShopCommit,
  ) {
    await this.audit.record(actor, {
      shopId: actor.shop.id,
      userId: actor.user.id,
      eventType: 'INVENTORY_UPDATED',
      resourceId: id,
      ipAddress: actor.ipAddress,
      metadata,
    }, scope);
    const effect = async () => {
      actor.log.info(
        { event: 'inventory_updated', inventoryItemId: id },
        'inventory updated',
      );
    };
    if (operationAfterCommit) operationAfterCommit(effect);
    else await effect();
  }
  async adjustInventory(
    actor: ActorContext,
    input: z.infer<typeof inventoryAdjustmentSchema>,
    key: string,
  ): Promise<{ adjusted: number; ids: string[] }> {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      return persistence.adjust({
        shopId: actor.shop.id,
        userId: actor.user.id,
        key,
        adjustments: input.adjustments,
      });
    });
  }

  async inventory(
    actor: ActorContext,
    query: InventoryQuery,
  ): Promise<{ items: InventoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      const items = await persistence.listInventory(actor.shop.id, query);
      return {
        items: items.map((item) => ({
          ...item,
          isLowStock:
            item.reorderLevel !== null &&
            toNumber(item.currentQuantity) <= toNumber(item.reorderLevel),
        })),
      };
    });
  }
}

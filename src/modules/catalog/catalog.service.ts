import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { toNumber } from '../../lib/money.js';
import { CatalogPersistence } from './catalog.persistence.js';
import type { CategoryDto, InventoryDto, InventoryQuery } from './contracts.js';

@Injectable()
export class CatalogService {
  constructor(@Inject(CatalogPersistence) private readonly persistence: CatalogPersistence) {}

  async categories(actor: ActorContext): Promise<{ categories: CategoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { categories: await this.persistence.listCategories(actor.shop.id) };
  }

  async inventory(actor: ActorContext, query: InventoryQuery): Promise<{ items: InventoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const items = await this.persistence.listInventory(actor.shop.id, query);
    return { items: items.map(item => ({
      ...item,
      isLowStock: item.reorderLevel !== null && toNumber(item.currentQuantity) <= toNumber(item.reorderLevel),
    })) };
  }
}

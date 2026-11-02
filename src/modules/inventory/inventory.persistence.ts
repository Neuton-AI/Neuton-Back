import { and, asc, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { db, type Database } from '../../db/client.js';
import type { TransactionalDatabase } from '../../db/types.js';
import { inventoryItems } from '../../db/schema/index.js';
import type { InventoryItem } from '../../db/schema/catalog.js';
import { notFound } from '../../lib/errors.js';
import { assertCatalogLinks } from '../../lib/catalogLinks.js';
import { quantity as qty, unitCost } from '../../lib/money.js';
import { adjustInventory } from '../../lib/inventoryAdjustments.js';
import type { InventoryInput, InventoryPatchInput, InventoryQuery, InventoryDto } from './contracts.js';
export const INVENTORY_DATABASE = Symbol('INVENTORY_DATABASE');


export function mapInventory(item: InventoryItem): Omit<InventoryDto, 'isLowStock'> {
  return {
    id: item.id, shopId: item.shopId, categoryId: item.categoryId,
    name: item.name, rawMaterialName: item.rawMaterialName, sku: item.sku,
    imageUrl: item.imageUrl, unit: item.unit, baseUnit: item.baseUnit,
    baseUnitAmount: item.baseUnitAmount, baseUnitCost: item.baseUnitCost,
    baseUnitAverageCost: item.baseUnitAverageCost, currentQuantity: item.currentQuantity,
    reorderLevel: item.reorderLevel, lastUnitCost: item.lastUnitCost,
    averageUnitCost: item.averageUnitCost, isActive: item.isActive,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
}
@Injectable()
export class InventoryPersistence {
  constructor(@Inject(INVENTORY_DATABASE) readonly database: TransactionalDatabase = db) {}

  async create(shopId: string, input: InventoryInput) {
    const rows = await this.database.transaction(async (tx) => {
      await assertCatalogLinks(tx, shopId, input);
      return tx
        .insert(inventoryItems)
        .values({
          shopId: shopId,
          name: input.name,
          rawMaterialName: input.rawMaterialName,
          sku: input.sku ?? null,
          imageUrl: input.imageUrl ?? null,
          categoryId: input.categoryId ?? null,
          unit: input.unit,
          baseUnit: input.baseUnit,
          baseUnitAmount: input.baseUnitAmount.toFixed(3),
          baseUnitCost: input.baseUnitCost.toFixed(6),
          currentQuantity: qty(input.currentQuantity),
          reorderLevel:
            input.reorderLevel === null || input.reorderLevel === undefined
              ? null
              : qty(input.reorderLevel),
          lastUnitCost:
            input.lastUnitCost === null || input.lastUnitCost === undefined
              ? null
              : unitCost(input.lastUnitCost),
          averageUnitCost:
            input.averageUnitCost === null ||
            input.averageUnitCost === undefined
              ? null
              : unitCost(input.averageUnitCost),
        })
        .returning();
    });

    if (!rows[0]) throw new Error('Inventory insert returned no row');
    return mapInventory(rows[0]);
  }
  async edit(shopId: string, id: string, input: InventoryPatchInput) {
    const updated = await this.database.transaction(async (tx) => {
      const existing = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shopId)),
        )
        .limit(1)
        .for('update');
      if (!existing[0]) throw notFound('Inventory item not found');
      await assertCatalogLinks(tx, shopId, input);

      const patch: Partial<typeof inventoryItems.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.rawMaterialName !== undefined)
        patch.rawMaterialName = input.rawMaterialName;
      if (input.sku !== undefined) patch.sku = input.sku ?? null;
      if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl ?? null;
      if (input.categoryId !== undefined)
        patch.categoryId = input.categoryId ?? null;
      if (input.unit !== undefined) patch.unit = input.unit;
      if (input.baseUnit !== undefined) patch.baseUnit = input.baseUnit;
      if (input.baseUnitAmount !== undefined)
        patch.baseUnitAmount = input.baseUnitAmount.toFixed(3);
      if (input.baseUnitCost !== undefined)
        patch.baseUnitCost = input.baseUnitCost.toFixed(6);
      if (input.currentQuantity !== undefined)
        patch.currentQuantity = qty(input.currentQuantity);
      if (input.reorderLevel !== undefined) {
        patch.reorderLevel =
          input.reorderLevel === null ? null : qty(input.reorderLevel);
      }
      if (input.lastUnitCost !== undefined) {
        patch.lastUnitCost =
          input.lastUnitCost === null ? null : unitCost(input.lastUnitCost);
      }
      if (input.averageUnitCost !== undefined) {
        patch.averageUnitCost =
          input.averageUnitCost === null
            ? null
            : unitCost(input.averageUnitCost);
      }

      return tx
        .update(inventoryItems)
        .set(patch)
        .where(
          and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shopId)),
        )
        .returning();
    });

    if (!updated[0]) throw notFound('Inventory item not found');
    return mapInventory(updated[0]);
  }
  async deactivate(shopId: string, id: string) {
    await this.database
      .update(inventoryItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shopId)));
  }
  adjust(input: Parameters<typeof adjustInventory>[1]) {
    return adjustInventory(this.database as Database, input);
  }


  async listInventory(shopId: string, query: InventoryQuery): Promise<Omit<InventoryDto, 'isLowStock'>[]> {
    const conditions = [eq(inventoryItems.shopId, shopId)];
    if (!query.includeInactive) conditions.push(eq(inventoryItems.isActive, true));
    if (query.search) conditions.push(sql`${inventoryItems.name} ilike ${`%${query.search}%`}`);
    if (query.lowStockOnly) conditions.push(
      sql`${inventoryItems.reorderLevel} is not null and ${inventoryItems.currentQuantity} <= ${inventoryItems.reorderLevel}`,
    );
    const rows = await this.database.select().from(inventoryItems)
      .where(and(...conditions)).orderBy(asc(inventoryItems.name));
    return rows.map(mapInventory);
  }
}

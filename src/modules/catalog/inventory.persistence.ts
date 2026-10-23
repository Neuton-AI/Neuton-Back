import { and, eq } from 'drizzle-orm';
import {
  inventoryItems,
  recipes,
  generalPrices,
} from '../../db/schema/index.js';
import { notFound, conflict } from '../../lib/errors.js';
import { assertCatalogLinks } from '../../lib/catalogLinks.js';
import { quantity as qty, unitCost } from '../../lib/money.js';
import { adjustInventory } from '../../lib/inventoryAdjustments.js';
import type { Database } from '../../db/client.js';
import type { CatalogDatabase } from './catalog.persistence.js';
import { mapInventory } from './catalog.persistence.js';
import type { InventoryInput, InventoryPatchInput } from './contracts.js';
import type { prepareManualProduct } from '../../lib/manualProduct.js';
import type { prepareBarcodePrice } from '../../lib/recipeBarcodePrice.js';

export class InventoryPersistence {
  constructor(readonly database: CatalogDatabase) {}
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
  async assertRecipe(shopId: string, id: string) {
    const [recipe] = await this.database
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
      .limit(1);
    if (!recipe) throw notFound('Recipe not found');
  }
  async manualProduct(
    shopId: string,
    product: ReturnType<typeof prepareManualProduct>,
  ) {
    const [saved] = await this.database
      .insert(inventoryItems)
      .values({ ...product, shopId })
      .onConflictDoNothing({
        target: [inventoryItems.shopId, inventoryItems.name],
      })
      .returning();
    if (!saved)
      throw conflict(
        'A product with this name already exists in this shop. Use a different name.',
      );
    return mapInventory(saved);
  }
  async barcodePrice(
    price: Awaited<ReturnType<typeof prepareBarcodePrice>>['price'],
  ) {
    const [saved] = await this.database
      .insert(generalPrices)
      .values(price)
      .onConflictDoUpdate({
        target: [generalPrices.rawMaterialName, generalPrices.sku],
        set: price,
      })
      .returning({ id: generalPrices.id });
    if (!saved) throw new Error('general price upsert returned no row');
    return saved.id;
  }
  adjust(input: Parameters<typeof adjustInventory>[1]) {
    return adjustInventory(this.database as Database, input);
  }
}

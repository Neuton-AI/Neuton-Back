import { and, asc, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { db, type Database } from '../../db/client.js';
import { categories, recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import type { InventoryItem } from '../../db/schema/catalog.js';
import type { CategoryDto, InventoryDto, InventoryQuery } from './contracts.js';

export type CatalogReadDatabase = Pick<Database, 'select'>;
export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

function mapInventory(item: InventoryItem): Omit<InventoryDto, 'isLowStock'> {
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
export class CatalogPersistence {
  constructor(@Inject(CATALOG_DATABASE) readonly database: CatalogReadDatabase = db) {}

  async listCategories(shopId: string): Promise<CategoryDto[]> {
    const rows = await this.database.select().from(categories)
      .where(eq(categories.shopId, shopId)).orderBy(asc(categories.name));
    return rows.map(row => ({
      id: row.id, shopId: row.shopId, name: row.name, createdAt: row.createdAt.toISOString(),
    }));
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

export async function readRecipeCostIngredients(
  shopId: string,
  recipeId: string,
  database: CatalogReadDatabase = db,
) {
  return database
    .select({
      id: recipeIngredients.id,
      inventoryItemId: recipeIngredients.inventoryItemId,
      generalPriceId: recipeIngredients.generalPriceId,
      rawName: recipeIngredients.rawName,
      rawSrcUnit: recipeIngredients.rawSrcUnit,
      rawMaterialName: recipeIngredients.rawMaterialName,
      baseUnit: recipeIngredients.baseUnit,
      baseUnitAmount: recipeIngredients.baseUnitAmount,
      quantity: recipeIngredients.quantity,
      name: sql<string>`coalesce(${inventoryItems.name}, ${generalPrices.rawName})`,
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: recipeIngredientUnitCost,
    })
    .from(recipeIngredients)
    .leftJoin(
      inventoryItems,
      and(eq(inventoryItems.id, recipeIngredients.inventoryItemId), eq(inventoryItems.shopId, shopId)),
    )
    .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
    .where(
      and(
        eq(recipeIngredients.shopId, shopId),
        eq(recipeIngredients.recipeId, recipeId),
      ),
    )
    .orderBy(asc(recipeIngredients.id));
}

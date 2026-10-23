import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import { recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';

export type CatalogReadDatabase = Pick<Database, 'select'>;

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

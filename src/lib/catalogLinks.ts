import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { categories, inventoryItems } from '../db/schema/index.js';
import { forbidden } from './errors.js';

/** Semantic request validation; locks preserve ownership until the write commits. */
export async function assertCatalogLinks(database: Pick<Database, 'select'>, shopId: string, input: {
  categoryId?: string | null;
  ingredients?: readonly { inventoryItemId?: string | null }[];
}): Promise<void> {
  if (input.categoryId) {
    const [category] = await database.select({ id: categories.id }).from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.shopId, shopId))).for('key share');
    if (!category) throw forbidden('Category must belong to this shop');
  }
  const ids = [...new Set(input.ingredients?.flatMap(item => item.inventoryItemId ? [item.inventoryItemId] : []) ?? [])];
  if (ids.length) {
    const owned = await database.select({ id: inventoryItems.id }).from(inventoryItems)
      .where(and(eq(inventoryItems.shopId, shopId), inArray(inventoryItems.id, ids))).for('key share');
    if (owned.length !== ids.length) throw forbidden('Ingredient inventory must belong to this shop');
  }
}

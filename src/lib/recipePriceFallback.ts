import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generalPrices, recipeIngredients } from '../db/schema/index.js';
import { searchProduct, type PriceResult } from './supermarket/prices.js';
import { normalizeProductPrice } from './supermarket/productConversion.js';

export function normalizePriceName(name: string): string {
  return name.trim().toLowerCase().replace(/[׳״'"’]/g, '').replace(/\s+/g, ' ');
}

// Code-point ordering is independent of host locale and input order. Include
// every conversion field so conflicting copies of a SKU also have a stable tie.
function tieKey(product: PriceResult): string {
  return JSON.stringify([product.ItemCode, product.chain, product.ItemName,
    product.UnitQty, product.Quantity, product.ItemPrice]);
}

export function selectFallbackProduct(results: PriceResult[]): PriceResult | null {
  return [...results].filter(product => Number.isFinite(product.score)).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const left = tieKey(a);
    const right = tieKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  })[0] ?? null;
}

type FallbackIngredient = {
  rawMaterialName: string;
  inventoryItemId?: string | null;
  generalPriceId?: string | null;
};
type PreparedPrices = Map<string, ReturnType<typeof normalizeProductPrice>>;

/** Call before opening a transaction; cache successes and failures per extraction. */
export async function prepareRecipeFallbackPrices(
  ingredients: readonly FallbackIngredient[],
  search: typeof searchProduct = searchProduct,
): Promise<PreparedPrices> {
  const matches: PreparedPrices = new Map();
  for (const ingredient of ingredients) {
    if (ingredient.inventoryItemId || ingredient.generalPriceId) continue;
    const query = normalizePriceName(ingredient.rawMaterialName);
    if (!query || matches.has(query)) continue;
    try {
      const product = selectFallbackProduct(await search(query));
      matches.set(query, product ? normalizeProductPrice(product, query) : null);
    } catch (error) {
      console.error('failed to fetch price for', query, error);
      matches.set(query, null);
    }
  }
  return matches;
}

/** Persist prepared results in the caller's short recipe transaction. No feed I/O. */
export async function persistRecipeFallbackPrices(
  database: Pick<Database, 'select' | 'insert' | 'update'>,
  shopId: string,
  recipeId: string,
  matches: PreparedPrices,
): Promise<void> {
  const ingredients = await database.select().from(recipeIngredients).where(and(
    eq(recipeIngredients.shopId, shopId), eq(recipeIngredients.recipeId, recipeId),
    isNull(recipeIngredients.inventoryItemId), isNull(recipeIngredients.generalPriceId),
  ));
  const savedIds = new Map<string, string>();
  for (const ingredient of ingredients) {
    if (ingredient.inventoryItemId || ingredient.generalPriceId) continue;
    const query = normalizePriceName(ingredient.rawMaterialName);
    const price = matches.get(query);
    if (!price) continue;
    let id = savedIds.get(query);
    if (!id) {
      const [saved] = await database.insert(generalPrices).values(price)
        .onConflictDoUpdate({ target: [generalPrices.rawMaterialName, generalPrices.sku], set: price })
        .returning({ id: generalPrices.id });
      if (!saved) throw new Error('general price upsert returned no row');
      id = saved.id;
      savedIds.set(query, id);
    }
    await database.update(recipeIngredients).set({ generalPriceId: id }).where(and(
      eq(recipeIngredients.id, ingredient.id), eq(recipeIngredients.shopId, shopId),
      eq(recipeIngredients.recipeId, recipeId),
      isNull(recipeIngredients.inventoryItemId), isNull(recipeIngredients.generalPriceId),
    ));
  }
}

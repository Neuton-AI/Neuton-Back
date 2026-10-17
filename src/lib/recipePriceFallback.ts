import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generalPrices, recipeIngredients } from '../db/schema/index.js';
import { searchProduct, type PriceResult } from './supermarket/prices.js';

export const MIN_FALLBACK_SCORE = 2000;

export function normalizePriceName(name: string): string {
  return name.trim().toLowerCase().replace(/[׳״'"’]/g, '').replace(/\s+/g, ' ');
}

export async function linkRecipeFallbackPrices(
  database: Pick<Database, 'select' | 'insert' | 'update'>,
  shopId: string,
  recipeId: string,
  search: typeof searchProduct = searchProduct,
): Promise<void> {
  const ingredients = await database.select().from(recipeIngredients).where(and(
    eq(recipeIngredients.shopId, shopId),
    eq(recipeIngredients.recipeId, recipeId),
    isNull(recipeIngredients.inventoryItemId),
    isNull(recipeIngredients.generalPriceId),
  ));
  const matches = new Map<string, PriceResult | null>();
  for (const ingredient of ingredients) {
    // Also guard in memory: retries must never replace an existing price link.
    if (ingredient.inventoryItemId || ingredient.generalPriceId) continue;
    // `rawMaterialName` is the shop-standardized query built for the supermarket APIs.
    const query = normalizePriceName(ingredient.rawMaterialName);
    if (!query) continue;
    if (!matches.has(query)) {
      try {
        const results = await search(query);
        const candidates = results.filter((result) => {
          const name = normalizePriceName(result.ItemName);
          const matchesIngredient = name === query || name.startsWith(`${query} `) || result.ItemCode === query;
          return matchesIngredient && result.score >= MIN_FALLBACK_SCORE &&
            Number.isFinite(Number(result.ItemPrice)) && +result.ItemPrice > 0;
        });
        candidates.sort((a, b) => b.score - a.score || +a.ItemPrice - +b.ItemPrice);
        matches.set(query, candidates[0] ?? null);
      } catch (e) {
        console.error("failed to fetch price for", query, e);
        matches.set(query, null);
      }
    }
    const product = matches.get(query);
    if (!product || !product.ItemCode.trim()) continue;
    const price = {
      rawMaterialName: query,
      rawName: product.ItemName,
      sku: product.ItemCode || null,
      rawSrcUnit: product.UnitOfMeasure || null,
      srcUnit: null,
      baseUnit: null,
      baseUnitAmount: null,
      baseUnitCost: null,
    };
    const [saved] = await database.insert(generalPrices).values(price)
      .onConflictDoUpdate({ target: [generalPrices.rawMaterialName, generalPrices.sku], set: price })
      .returning({ id: generalPrices.id });
    if (!saved) throw new Error('general price upsert returned no row');
    await database.update(recipeIngredients).set({ generalPriceId: saved.id }).where(and(
      eq(recipeIngredients.id, ingredient.id),
      eq(recipeIngredients.shopId, shopId),
      isNull(recipeIngredients.inventoryItemId),
      isNull(recipeIngredients.generalPriceId),
    ));
  }
}

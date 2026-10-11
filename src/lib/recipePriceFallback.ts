import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generalPrices, recipeIngredients } from '../db/schema/index.js';
import { searchProduct, type PriceResult } from './supermarket/prices.js';

// searchProduct scores are not probabilities. Require 2000 AND an ingredient
// name prefix (or exact barcode): incidental matches such as "chocolate milk"
// must not satisfy a search for "milk", even when their score is high.
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
    const query = normalizePriceName(ingredient.rawName);
    if (!query) continue;
    if (!matches.has(query)) {
      try {
        const results = await search(query);
        const candidates = results.filter((result) => {
          const name = normalizePriceName(result.name);
          const matchesIngredient = name === query || name.startsWith(`${query} `) || result.barcode === query;
          return matchesIngredient && result.score >= MIN_FALLBACK_SCORE &&
            Number.isFinite(result.price) && result.price > 0;
        });
        candidates.sort((a, b) => b.score - a.score || a.price - b.price);
        matches.set(query, candidates[0] ?? null);
      } catch {
        // A catalog outage leaves the line available for manual review.
        matches.set(query, null);
      }
    }
    const product = matches.get(query);
    if (!product) continue;
    const now = new Date();
    const price = {
      normalizedName: normalizePriceName(product.name),
      name: product.name,
      barcode: product.barcode,
      manufacturer: product.manufacturer ?? null,
      chain: product.chain,
      priceIls: product.price.toFixed(2),
      fetchedAt: now,
      updatedAt: now,
    };
    const [saved] = await database.insert(generalPrices).values(price)
      .onConflictDoUpdate({ target: generalPrices.normalizedName, set: price })
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

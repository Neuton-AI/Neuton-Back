import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generalPrices, recipeIngredients } from '../db/schema/index.js';
import { searchProduct, type PriceResult } from './supermarket/prices.js';
import { isFoodCandidate } from './supermarket/measurements.js';
import { quantity, unitCost } from './money.js';

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
    // `searchAbleName` is the shop-standardized query built for the supermarket APIs.
    const query = normalizePriceName(ingredient.searchAbleName);
    if (!query) continue;
    const context = ingredient.measurementContext as { alternatives?: string[]; selectedAlternative?: string } | null;
    if (context?.alternatives?.length && !context.selectedAlternative) continue;
    if (!matches.has(query)) {
      try {
        const results = await search(query);
        const candidates = results.filter((result) => {
          const name = normalizePriceName(result.name);
          const matchesIngredient = name === query || name.startsWith(`${query} `) || result.barcode === query;
          return matchesIngredient && isFoodCandidate(result.name) && result.score >= MIN_FALLBACK_SCORE &&
            Number.isFinite(result.price) && result.price >= 0;
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
      offerKey: [product.chain, product.chainId ?? '', product.subchainId ?? '', product.storeId ?? '', product.barcode].join(':'),
      chainId: product.chainId ?? null,
      subchainId: product.subchainId ?? null,
      storeId: product.storeId ?? null,
      sourceUpdatedAt: product.sourceUpdatedAt ?? null,
      sourceUrl: product.sourceUrl ?? null,
      packageQuantity: product.measurement?.measurement ? quantity(product.measurement.measurement.quantity) : null,
      packageUnit: product.measurement?.measurement?.unit ?? null,
      pricePerBaseUnit: product.measurement?.measurement ? unitCost(product.price / product.measurement.measurement.quantity) : null,
      measurementStatus: product.measurement?.state ?? 'unresolved',
      measurementReason: product.measurement?.reason ?? 'missing_package_size',
      measurementEvidence: product.evidence ?? null,
      name: product.name,
      barcode: product.barcode,
      manufacturer: product.manufacturer ?? null,
      chain: product.chain,
      priceIls: product.price.toFixed(2),
      fetchedAt: product.fetchedAt ?? now,
      updatedAt: now,
    };
    const [saved] = await database.insert(generalPrices).values(price)
      .onConflictDoUpdate({ target: generalPrices.offerKey, set: price })
      .returning({ id: generalPrices.id });
    if (!saved) throw new Error('general price upsert returned no row');
    await database.update(recipeIngredients).set({ generalPriceId: saved.id }).where(and(
      eq(recipeIngredients.id, ingredient.id),
      eq(recipeIngredients.shopId, shopId),
      eq(recipeIngredients.searchAbleName, ingredient.searchAbleName),
      isNull(recipeIngredients.inventoryItemId),
      isNull(recipeIngredients.generalPriceId),
    ));
  }
}

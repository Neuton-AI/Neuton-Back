import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { inventoryItems } from '../db/schema/index.js';

interface IngredientNames {
  rawMaterialName?: string | null;
  rawName: string;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Exact, shop-scoped recipe matching; receipt matching remains independent.
 * Material names win over display names. For duplicate names, the lowest UUID
 * wins (stable across query order and retries). Empty names never match.
 * Return one link per input line: material names are not unique line keys.
 */
export async function resolveRecipeInventoryLinks(
  db: Pick<Database, 'select'>,
  shopId: string,
  ingredients: readonly IngredientNames[],
): Promise<(string | null)[]> {
  if (ingredients.length === 0) return [];
  const candidates = await db.select({
    id: inventoryItems.id,
    name: inventoryItems.name,
    rawMaterialName: inventoryItems.rawMaterialName,
  }).from(inventoryItems).where(eq(inventoryItems.shopId, shopId));
  const materials = new Map<string, string>();
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    for (const [index, value] of [
      [materials, candidate.rawMaterialName], [names, candidate.name],
    ] as const) {
      const key = normalizeName(value);
      const previous = index.get(key);
      if (key && (!previous || candidate.id < previous)) index.set(key, candidate.id);
    }
  }
  return ingredients.map((ingredient) =>
    materials.get(normalizeName(ingredient.rawMaterialName)) ??
    names.get(normalizeName(ingredient.rawName)) ?? null,
  );
}

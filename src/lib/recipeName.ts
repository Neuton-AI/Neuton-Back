/**
 * Recipe naming for the vision worker.
 *
 * `recipes` carries a unique index on `(shopId, name)` (`recipes_shop_id_name_unique`),
 * so writing a recipe whose name already exists in the shop throws a
 * unique-constraint violation (23505) and fails the job. This resolves the
 * collision before the write, Windows-style: "Name", "Name (2)", "Name (3)".
 */
import { and, eq, ilike, ne, sql } from 'drizzle-orm';
import { recipes } from '../db/schema/index.js';

/**
 * A Drizzle client or a transaction handle. The helper chains a few builder
 * methods, so the handle is typed loosely and every call site stays
 * type-checked. Mirrors `InventoryDb`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RecipeNamingDb = any;

/** Escapes the characters `ILIKE` treats as wildcards so a name matches literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Returns a name that is unique within `shopId`.
 *
 * When `desiredName` — or anything sharing its prefix — already exists, the next
 * ordinal is appended: the first duplicate becomes "Name (2)", the second
 * "Name (3)", and so on. The prefix is matched with `ILIKE` so it is
 * case-insensitive, and `excludeRecipeId` keeps a recipe from colliding with
 * itself when it is re-extracted.
 */
export async function resolveUniqueRecipeName(
  db: RecipeNamingDb,
  shopId: string,
  desiredName: string,
  excludeRecipeId?: string,
): Promise<string> {
  const name = desiredName.trim();
  if (name.length === 0) return name;

  const prefix = escapeLikePattern(name);
  const selfFilter = excludeRecipeId ? [ne(recipes.id, excludeRecipeId)] : [];

  // Count the recipes already sharing this prefix.
  const counted = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recipes)
    .where(and(eq(recipes.shopId, shopId), ilike(recipes.name, `${prefix}%`), ...selfFilter));
  const existing = counted[0]?.count ?? 0;
  if (existing === 0) return name;

  // Resume after the ones counted, then step past any name already taken so a
  // gap in the sequence ("Name (3)" without "Name (2)") can never collide.
  const siblings = await db
    .select({ name: recipes.name })
    .from(recipes)
    .where(and(eq(recipes.shopId, shopId), ilike(recipes.name, `${prefix} (%`), ...selfFilter));
  const taken = new Set<string>(siblings.map((row: { name: string }) => row.name));

  let ordinal = existing + 1;
  while (taken.has(`${name} (${ordinal})`)) ordinal += 1;
  return `${name} (${ordinal})`;
}

import { and, eq } from 'drizzle-orm';
import slugify from 'slugify';
import type { Database } from '../db/client.js';
import { shops } from '../db/schema/index.js';
import { RESERVED_SLUGS } from '../db/schema/enums.js';

/**
 * Collision-safe slug generation per the database characterization strategy:
 * normalize → sanitize → kebab-case → trim, then append `-1`, `-2`, … until free.
 */
export async function generateUniqueSlug(
  shopName: string,
  db: Database,
  options: { excludeShopId?: string } = {},
): Promise<string> {
  const baseSlug = slugify(shopName, { lower: true, strict: true, trim: true });
  if (!baseSlug) {
    throw new Error('Cannot derive a slug from the supplied shop name');
  }

  const exists = async (candidate: string): Promise<boolean> => {
    const conditions = [eq(shops.slug, candidate)];
    if (options.excludeShopId) {
      conditions.push(eq(shops.id, options.excludeShopId));
    }
    const rows = await db
      .select({ id: shops.id })
      .from(shops)
      .where(
        and(...conditions),
      )
      .limit(1);
    return rows.length > 0;
  };

  const safeBase = (RESERVED_SLUGS as readonly string[]).includes(baseSlug)
    ? `${baseSlug}-shop`
    : baseSlug;

  let candidate = safeBase;
  let counter = 1;
  while (await exists(candidate)) {
    candidate = `${safeBase}-${counter}`;
    counter += 1;
  }
  return candidate;
}

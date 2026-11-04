import slugify from 'slugify';
import { RESERVED_SLUGS } from '../db/schema/enums.js';

/** Uniqueness is resolved by the narrow bootstrap routine, without cross-shop reads. */
export function shopSlugBase(shopName: string): string {
  let slug = slugify(shopName, { lower: true, strict: true, trim: true }).slice(0, 70);
  if (slug.length < 2) slug = 'shop';
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) slug += '-shop';
  return slug;
}
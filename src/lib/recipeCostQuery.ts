import { sql } from 'drizzle-orm';
import { generalPrices, inventoryItems } from '../db/schema/index.js';

/** Inventory remains authoritative; external prices only cost fallback links. */
export const recipeIngredientUnitCost = sql<string>`coalesce(${inventoryItems.averageUnitCost}, ${generalPrices.priceIls})`;

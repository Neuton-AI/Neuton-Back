import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { INVENTORY_UNITS, PRICE_CHAINS, RECIPE_STATUSES } from './enums.js';
import { shops } from './identity.js';

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopNameUnique: uniqueIndex('categories_shop_id_name_unique').on(t.shopId, t.name),
}));

export const inventoryItems = pgTable('inventory_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  sku: text('sku'),
  imageUrl: text('image_url'),
  unit: text('unit', { enum: INVENTORY_UNITS }).notNull(),
  baseUnit: text('base_unit').notNull(),
  baseUnitAmount: numeric('base_unit_amount', { precision: 12, scale: 2 }).notNull(),
  baseUnitCost: numeric('base_unit_cost', { precision: 18, scale: 6 }).notNull(),
  currentQuantity: numeric('current_quantity', { precision: 12, scale: 3 }).notNull().default('0'),
  reorderLevel: numeric('reorder_level', { precision: 12, scale: 3 }),
  lastUnitCost: numeric('last_unit_cost', { precision: 12, scale: 4 }),
  averageUnitCost: numeric('average_unit_cost', { precision: 12, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopNameUnique: uniqueIndex('inventory_items_shop_id_name_unique').on(t.shopId, t.name),
  skuIdx: index('inventory_items_shop_id_sku_idx')
    .on(t.shopId, t.sku)
    .where(sql`${t.sku} IS NOT NULL`),
}));

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  prepTimeMinutes: integer('prep_time_minutes').notNull().default(0),
  yieldQuantity: numeric('yield_quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  yieldUnit: text('yield_unit').notNull().default('portion'),
  targetMarginPct: numeric('target_margin_pct', { precision: 5, scale: 2 }),
  allergens: text('allergens').array(),
  instructions: text('instructions'),
  isActive: boolean('is_active').notNull().default(true),
  status: text('status', { enum: RECIPE_STATUSES }).notNull().default('pending'),
  storagePath: text('storage_path'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopNameUnique: uniqueIndex('recipes_shop_id_name_unique').on(t.shopId, t.name),
  shopIdx: index('recipes_shop_id_idx').on(t.shopId),
  shopStatusIdx: index('recipes_shop_id_status_idx').on(t.shopId, t.status),
  shopStoragePathUnique: uniqueIndex('recipes_shop_id_storage_path_unique')
    .on(t.shopId, t.storagePath)
    .where(sql`${t.storagePath} IS NOT NULL`),
}));

/**
 * A *global* (not per-shop) cache of supermarket prices fetched from the
 * Israeli PriceFull feeds. An unlinked recipe ingredient — one whose material
 * the shop does not stock — points here so cost calc stops falling back to 0.
 *
 * Global because the same product price is shared by every shop, and read-only
 * for shops: the worker owns the rows and refreshes them. `normalized_name` is
 * the lookup key (unique); `barcode` is indexed for scan-based matching.
 */
export const generalPrices = pgTable('general_prices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  normalizedName: text('normalized_name').notNull(),
  barcode: text('barcode'),
  name: text('name').notNull(),
  manufacturer: text('manufacturer'),
  chain: text('chain', { enum: PRICE_CHAINS }).notNull(),
  priceIls: numeric('price_ils', { precision: 12, scale: 2 }).notNull(),
  packageQuantity: numeric('package_quantity', { precision: 12, scale: 3 }),
  packageUnit: text('package_unit'),
  pricePerBaseUnit: numeric('price_per_base_unit', { precision: 12, scale: 4 }),
  sourceUrl: text('source_url'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  normalizedNameUnique: uniqueIndex('general_prices_normalized_name_unique').on(t.normalizedName),
  barcodeIdx: index('general_prices_barcode_idx').on(t.barcode),
}));

export const recipeIngredients = pgTable('recipe_ingredients', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'cascade' }),
  inventoryItemId: uuid('inventory_item_id').references(() => inventoryItems.id, {
    onDelete: 'restrict',
  }),
  generalPriceId: uuid('general_price_id').references(() => generalPrices.id, {
    onDelete: 'set null',
  }),
  rawName: text('raw_name').notNull(),
  searchAbleName: text('search_able_name').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  unit: text('unit').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  recipeItemUnique: uniqueIndex('recipe_ingredients_recipe_id_inventory_item_id_unique').on(
    t.recipeId,
    t.inventoryItemId,
  ),
  recipeRawNameUnique: uniqueIndex('recipe_ingredients_recipe_id_raw_name_unique').on(
    t.recipeId,
    t.rawName,
  ),
  shopIdx: index('recipe_ingredients_shop_id_idx').on(t.shopId),
  priceLinkCheck: check(
    'recipe_ingredients_price_link_check',
    sql`num_nonnulls(${t.inventoryItemId}, ${t.generalPriceId}) <= 1`,
  ),
}));

export type Category = typeof categories.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type GeneralPrice = typeof generalPrices.$inferSelect;
export type NewGeneralPrice = typeof generalPrices.$inferInsert;
export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
export type RecipeIngredient = typeof recipeIngredients.$inferSelect;
export type NewRecipeIngredient = typeof recipeIngredients.$inferInsert;

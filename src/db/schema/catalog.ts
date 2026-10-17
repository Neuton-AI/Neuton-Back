import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { INVENTORY_UNITS, RECIPE_STATUSES } from './enums.js';
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
  rawMaterialName: text('raw_material_name').notNull(),
  sku: text('sku'),
  imageUrl: text('image_url'),
  unit: text('unit', { enum: INVENTORY_UNITS }).notNull(),
  baseUnit: text('base_unit').notNull(),
  baseUnitAmount: numeric('base_unit_amount', { precision: 24, scale: 3 }).notNull(),
  baseUnitCost: numeric('base_unit_cost', { precision: 18, scale: 6 }).notNull(),
  baseUnitAverageCost: numeric('base_unit_average_cost', { precision: 18, scale: 6 }).notNull().default('0'),
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
  steps: jsonb('steps').$type<{ stepNumber: number; instruction: string }[]>().notNull().default([]),
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

/** Global material/SKU cache. Null conversions are deliberately unresolved. */
export const generalPrices = pgTable('general_prices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  rawName: text('raw_name').notNull(),
  sku: text('sku'),
  rawMaterialName: text('raw_material_name').notNull(),
  rawSrcUnit: text('raw_src_unit'),
  srcUnit: text('src_unit'),
  baseUnit: text('base_unit'),
  baseUnitAmount: numeric('base_unit_amount', { precision: 24, scale: 3 }),
  baseUnitCost: numeric('base_unit_cost', { precision: 18, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  materialSkuUnique: uniqueIndex('general_prices_material_sku_unique').on(t.rawMaterialName, t.sku),
  skuIdx: index('general_prices_sku_idx').on(t.sku),
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
  rawMaterialName: text('raw_material_name').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  rawSrcUnit: text('raw_src_unit').notNull(),
  baseUnit: text('base_unit'),
  baseUnitAmount: numeric('base_unit_amount', { precision: 24, scale: 3 }),
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

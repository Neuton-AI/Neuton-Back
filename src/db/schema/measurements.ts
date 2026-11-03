import { numeric, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { shops } from './identity.js';

/** Retained handwritten relations from the historical 0017 migration. */
export const productMeasurements = pgTable('product_measurements', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  productKey: text('product_key').notNull(),
  packageQuantity: numeric('package_quantity', { precision: 20, scale: 6 }).notNull(),
  packageUnit: text('package_unit').notNull(),
  packagesPerPurchase: numeric('packages_per_purchase', { precision: 20, scale: 6 }).notNull().default('1'),
  evidence: jsonb('evidence').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ product: uniqueIndex('product_measurements_shop_product_unique').on(table.shopId, table.productKey) }));

export const ingredientConversions = pgTable('ingredient_conversions', {
  id: uuid('id').primaryKey().defaultRandom(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  scopeKey: text('scope_key').notNull(),
  profile: jsonb('profile').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ scope: uniqueIndex('ingredient_conversions_shop_scope_unique').on(table.shopId, table.scopeKey) }));

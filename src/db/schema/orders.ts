import { sql } from 'drizzle-orm';
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { recipes } from './catalog.js';
import { profiles, shops } from './identity.js';

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  customerName: text('customer_name'),
  orderDate: timestamp('order_date', { withTimezone: true }).notNull().defaultNow(),
  destinationAddress: text('destination_address'),
  deliveryDistanceKm: numeric('delivery_distance_km', { precision: 8, scale: 2 })
    .notNull()
    .default('0.00'),
  deliveryFee: numeric('delivery_fee', { precision: 10, scale: 2 }).notNull().default('0.00'),
  appliedProfitMargin: numeric('applied_profit_margin', { precision: 5, scale: 2 }),
  totalCost: numeric('total_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
  documentUrl: text('document_url'),
  status: text('status').notNull().default('processing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  shopDateIdx: index('orders_shop_id_order_date_idx').on(t.shopId, t.orderDate),
  shopDeletedIdx: index('orders_shop_id_deleted_at_idx').on(t.shopId, t.deletedAt),
  shopStatusIdx: index('orders_shop_id_status_idx').on(t.shopId, t.status),
}));

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'restrict' }),
  /**
   * The recipe's name at the moment the order line was written (N-107).
   *
   * Order history is a record of what was sold, so renaming a recipe must not
   * rewrite labels on orders that already went out. Nullable only so the
   * migration can backfill; reads go through `orderItemRecipeName`, which falls
   * back to the live name for any row that still predates the snapshot.
   */
  recipeName: text('recipe_name'),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  unitCost: numeric('unit_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0.00'),
}, (t) => ({
  orderIdx: index('order_items_order_id_idx').on(t.orderId),
}));

/**
 * The label an order line reports: the name snapshotted when the line was
 * written, falling back to the live recipe name for rows that still predate
 * N-107's backfill. Snapshot-first is the point — renaming a recipe must never
 * rewrite orders that already went out, and a recipe with no row left must
 * never blank one.
 */
export const orderItemRecipeName = sql<string>`coalesce(${orderItems.recipeName}, ${recipes.name})`;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

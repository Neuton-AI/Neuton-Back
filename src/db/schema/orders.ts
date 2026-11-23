import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { recipes } from './catalog.js';
import { shops, users } from './identity.js';

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  /**
   * Per-shop sequential invoice number (N-105).
   *
   * Issued exactly once, inside the creating transaction, by incrementing
   * `shops.last_order_number`; unique per shop, never reused. There is no
   * DEFAULT — an insert that does not ask the counter for a number is a bug,
   * not a fallback, because a number nobody issued cannot be audited.
   */
  orderNumber: integer('order_number').notNull(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  customerName: text('customer_name'),
  orderDate: timestamp('order_date', { withTimezone: true }).notNull().defaultNow(),
  /** Requested calendar date; null means historically unknown. */
  deliveryDate: date('delivery_date', { mode: 'string' }),
  destinationAddress: text('destination_address'),
  deliveryDistanceKm: numeric('delivery_distance_km', { precision: 8, scale: 2 })
    .notNull()
    .default('0.00'),
  deliveryFee: numeric('delivery_fee', { precision: 10, scale: 2 }).notNull().default('0.00'),
  appliedProfitMargin: numeric('applied_profit_margin', { precision: 5, scale: 2 }),
  totalCost: numeric('total_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
  /** Partial-order profit freezes calculation precision lost by 2dp line costs. */
  profitSnapshot: numeric('profit_snapshot', { precision: 10, scale: 2 }),
  documentUrl: text('document_url'),
  status: text('status').notNull().default('processing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  cancellationMadeItems: boolean('cancellation_made_items'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  shopDateIdx: index('orders_shop_id_order_date_idx').on(t.shopId, t.orderDate),
  shopDeletedIdx: index('orders_shop_id_deleted_at_idx').on(t.shopId, t.deletedAt),
  shopStatusIdx: index('orders_shop_id_status_idx').on(t.shopId, t.status),
  shopOrderNumberUnique: uniqueIndex('orders_shop_id_order_number_unique').on(t.shopId, t.orderNumber),
}));

export const orderPayments = pgTable('order_payments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  kind: text('kind', { enum: ['deposit', 'payment', 'refund'] }).notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
}, (t) => ({
  orderIdx: index('order_payments_order_id_idx').on(t.orderId),
  refundUnique: uniqueIndex('order_payments_one_refund_per_order').on(t.orderId).where(sql`${t.kind} = 'refund'`),
  kindCheck: check('order_payments_kind_check', sql`${t.kind} IN ('deposit', 'payment', 'refund')`),
  positiveAmount: check('order_payments_positive_amount', sql`${t.amount} > 0 AND ${t.amount} <> 'NaN'::numeric`),
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
  /** Frozen at creation; null preserves unknown legacy provenance. */
  costComplete: boolean('cost_complete'),
  unitCost: numeric('unit_cost', { precision: 10, scale: 2 }).notNull().default('0.00'),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0.00'),
}, (t) => ({
  orderIdx: index('order_items_order_id_idx').on(t.orderId),
  stockSource: uniqueIndex('order_items_stock_source_unique').on(t.id, t.shopId, t.recipeId),
}));

export const finishedStock = pgTable('finished_stock', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'restrict' }),
  recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'restrict' }),
  sourceOrderItemId: uuid('source_order_item_id').notNull(),
  quantityAdded: integer('quantity_added').notNull(),
  quantityRemaining: integer('quantity_remaining').notNull(),
  unitCost: numeric('unit_cost', { precision: 10, scale: 2 }).notNull(),
  costComplete: boolean('cost_complete'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopIdx: index('finished_stock_shop_id_idx').on(t.shopId),
  lineUnique: uniqueIndex('finished_stock_source_line_unique').on(t.sourceOrderItemId),
  sourceLine: foreignKey({ name: 'finished_stock_source_line_fk', columns: [t.sourceOrderItemId, t.shopId, t.recipeId],
    foreignColumns: [orderItems.id, orderItems.shopId, orderItems.recipeId] }).onDelete('restrict'),
  quantityCheck: check('finished_stock_quantities_check',
    sql`${t.quantityAdded} > 0 AND ${t.quantityRemaining} BETWEEN 0 AND ${t.quantityAdded}`),
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

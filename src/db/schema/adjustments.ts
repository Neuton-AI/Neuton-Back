import { jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { shops } from './identity.js';

export interface InventoryAdjustmentResult {
  adjusted: number;
  ids: string[];
}

/** Kept until shop deletion so delayed retries cannot apply another delta. */
export const inventoryAdjustmentBatches = pgTable('inventory_adjustment_batches', {
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  id: uuid('id').notNull(),
  userId: uuid('user_id').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response').$type<InventoryAdjustmentResult>(),
}, table => ({ primary: primaryKey({ columns: [table.shopId, table.id] }) }));

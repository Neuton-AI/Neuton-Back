import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { profiles, shops } from './identity.js';
import { receipts } from './receipts.js';
import { recipes } from './catalog.js';
import { orders } from './orders.js';

export interface SourcePreview {
  storagePath: string;
  contentType: 'image/webp';
  width: number;
  height: number;
}

export interface UploadSource {
  sourceId: string;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  byteSize: number;
  preview?: SourcePreview;
}

/** Immutable source order and stable business identity survive browser/queue retries. */
export const mediaUploads = pgTable('media_uploads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => profiles.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: ['receipt', 'recipe', 'product', 'order'] }).notNull(),
  sources: jsonb('sources').$type<UploadSource[]>().notNull(),
  receiptId: uuid('receipt_id'),
  recipeId: uuid('recipe_id'),
  orderId: uuid('order_id'),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopIdx: index('media_uploads_shop_id_idx').on(t.shopId),
  tenantId: uniqueIndex('media_uploads_shop_id_id_unique').on(t.shopId, t.id),
  receiptTenant: foreignKey({ name: 'uploads_receipt_shop_fk', columns: [t.shopId, t.receiptId],
    foreignColumns: [receipts.shopId, receipts.id] }).onDelete('cascade'),
  recipeTenant: foreignKey({ name: 'uploads_recipe_shop_fk', columns: [t.shopId, t.recipeId],
    foreignColumns: [recipes.shopId, recipes.id] }).onDelete('cascade'),
  orderTenant: foreignKey({ name: 'uploads_order_shop_fk', columns: [t.shopId, t.orderId],
    foreignColumns: [orders.shopId, orders.id] }).onDelete('cascade'),
  sourceCount: check('media_uploads_source_count', sql`jsonb_array_length(${t.sources}) BETWEEN 1 AND 4`),
}));

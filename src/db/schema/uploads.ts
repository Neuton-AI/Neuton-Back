import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  receiptId: uuid('receipt_id').references(() => receipts.id, { onDelete: 'cascade' }),
  recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopIdx: index('media_uploads_shop_id_idx').on(t.shopId),
  sourceCount: check('media_uploads_source_count', sql`jsonb_array_length(${t.sources}) BETWEEN 1 AND 4`),
}));

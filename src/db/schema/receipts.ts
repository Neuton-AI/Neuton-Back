import { sql } from 'drizzle-orm';
import {
  char,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { RECEIPT_REVIEW_STATUSES, RECEIPT_STATUSES } from './enums.js';
import { inventoryItems } from './catalog.js';
import { profiles, shops } from './identity.js';

/**
 * Where the *worker* is up to, not where the receipt is in its lifecycle.
 *
 * `progress_stage: 'completed'` means "the extraction job finished" — it says
 * nothing about whether a human has approved the receipt. `receipts.status` is
 * the single source of truth for verification, so read `progress_stage` only
 * while `status` is `pending` or `processing` and ignore it after.
 *
 * `applying` was dropped in N-28 along with the worker's inventory writes;
 * `validating` now covers reading the lines back in. Anything reading a stored
 * value from before that change must expect it.
 */
export const RECEIPT_PROGRESS_STAGES = [
  'pending',
  'extracting',
  'validating',
  'completed',
  'failed',
] as const;
export type ReceiptProgressStage = (typeof RECEIPT_PROGRESS_STAGES)[number];

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => profiles.id, { onDelete: 'set null' }),
  storagePath: text('storage_path'),
  /** MIME type actually stored in R2; the detail sheet renders PDFs differently. */
  contentType: text('content_type'),
  originalFilename: text('original_filename'),
  merchantName: text('merchant_name'),
  merchantAddress: text('merchant_address'), // the specific chain branch location/number
  receiptDate: date('receipt_date'),
  paymentMethod: text('payment_method'),
  totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }),
  currency: char('currency', { length: 3 }),
  status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('pending'),
  progressStage: text('progress_stage', { enum: RECEIPT_PROGRESS_STAGES }).default('pending'),
  progressMessage: text('progress_message'),
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  processingDeadline: timestamp('processing_deadline', { withTimezone: true }),
  rawExtraction: jsonb('raw_extraction'),
  errorMessage: text('error_message'),
  /**
   * When extraction finished — not when the receipt was applied. Since N-28 the
   * worker stops here and never touches inventory, so the moment a human
   * approved the receipt lives on `verified_at` instead.
   */
  processedAt: timestamp('processed_at', { withTimezone: true }),
  /** The user who approved the receipt's lines; null until verified. */
  verifiedBy: uuid('verified_by').references(() => profiles.id, { onDelete: 'set null' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopDateIdx: index('receipts_shop_id_receipt_date_idx').on(t.shopId, t.receiptDate),
  shopStatusIdx: index('receipts_shop_id_status_idx').on(t.shopId, t.status),
}));

export const receiptItems = pgTable('receipt_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  receiptId: uuid('receipt_id')
    .notNull()
    .references(() => receipts.id, { onDelete: 'cascade' }),
  /**
   * The inventory row this line resolved to, written by the *verification*
   * pass, never by the worker. `NULL` therefore means "not yet applied": as of
   * N-28 the worker saves lines and stops, so a freshly extracted receipt has
   * every line null here until someone approves it.
   */
  inventoryItemId: uuid('inventory_item_id').references(() => inventoryItems.id, {
    onDelete: 'set null',
  }),
  rawName: text('raw_name').notNull(),
  rawSku: text('raw_sku'),
  quantity: numeric('quantity', { precision: 12, scale: 3 }),
  unitPrice: numeric('unit_price', { precision: 12, scale: 4 }),
  totalPrice: numeric('total_price', { precision: 12, scale: 2 }),
  /**
   * The unit exactly as the model read it, in whatever spelling it used. The
   * worker used to coerce this into `INVENTORY_UNITS` on the way in, which
   * destroyed the value the reviewer needed to see in order to correct it; the
   * map to a known inventory unit now happens when the line is applied.
   */
  unit: text('unit'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  /**
   * Outcome of the human review pass. `pending` is the default and the only
   * value the vision worker ever writes — it does not review anything.
   */
  reviewStatus: text('review_status', { enum: RECEIPT_REVIEW_STATUSES })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  receiptIdx: index('receipt_items_receipt_id_idx').on(t.receiptId),
  shopItemIdx: index('receipt_items_shop_id_inventory_item_id_idx').on(
    t.shopId,
    t.inventoryItemId,
  ),
  shopSkuIdx: index('receipt_items_shop_id_raw_sku_idx')
    .on(t.shopId, t.rawSku)
    .where(sql`${t.rawSku} IS NOT NULL`),
}));

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type NewReceiptItem = typeof receiptItems.$inferInsert;

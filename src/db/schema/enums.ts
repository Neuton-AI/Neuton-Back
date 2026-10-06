export const SHOP_ROLES = ['owner', 'admin', 'member'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

/**
 * The receipt lifecycle as the *user* sees it:
 *
 * `pending` → `processing` → `unverified` → `verified`
 *
 * `unverified` is where the worker stops: the document has been read and the
 * lines saved, but nobody has approved them and inventory has not moved.
 * `verified` is only ever written by `POST /receipts/:id/verify`, and that same
 * word is what analytics counts as spend, so `unverified` receipts are
 * deliberately absent from revenue and expense totals.
 *
 * `completed` is retired as of N-28. Every historical `completed` row was
 * rewritten to `verified` by `0007_receipt_status_switchover.sql`, which matters
 * more than it sounds: there is no CHECK constraint on `receipts.status`, so
 * nothing but that backfill stops a stray `completed` from surviving as a value
 * no query in the codebase matches.
 */
export const RECEIPT_STATUSES = [
  'pending',
  'processing',
  'unverified',
  'verified',
  'failed',
] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Per-line outcome of the human review pass. Lines start at `pending`. */
export const RECEIPT_REVIEW_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type ReceiptReviewStatus = (typeof RECEIPT_REVIEW_STATUSES)[number];

export const INVENTORY_UNITS = ['kg', 'g', 'l', 'ml', 'unit', 'pack'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const MEDIA_KINDS = ['receipt', 'recipe', 'product', 'order'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Slugs that must never be handed out to a shop because they collide with app routes. */
export const RESERVED_SLUGS = [
  'admin',
  'app',
  'api',
  'login',
  'settings',
  'dashboard',
  'profile',
  'catalog',
  'orders',
  'capture',
  'auth',
] as const;

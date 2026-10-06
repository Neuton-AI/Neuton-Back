export const SHOP_ROLES = ['owner', 'admin', 'member'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

/**
 * `completed` is what the vision worker still emits today, so it stays in the
 * union: analytics filters on it, and removing it here would make every receipt
 * the worker produces vanish from revenue and expense totals. N-28 flips the
 * worker to `unverified` and analytics to `verified`, then drops `completed`.
 */
export const RECEIPT_STATUSES = [
  'pending',
  'processing',
  'unverified',
  'verified',
  'completed',
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

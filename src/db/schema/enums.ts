export const SHOP_ROLES = ['owner', 'admin', 'member'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

export const RECEIPT_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

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

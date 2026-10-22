import type { ShopRole } from '../../db/schema/enums.js';
import type { Logger } from '../../lib/logger/types.js';

export interface AuthUser {
  id: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface ShopContext {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  storeAddress: string | null;
  targetProfitMargin: string;
  hourlyLaborCost: string;
  deliveryBaseFee: string;
  deliveryRatePerKm: string;
}

/** Verified identity and explicit tenant scope passed into application services. */
export interface ActorContext {
  user: AuthUser;
  shop: ShopContext;
  role: ShopRole;
  requestId: string;
  traceId: string;
  ipAddress?: string;
  log: Logger;
}

export type { ShopRole };

import type { ShopContext } from '../identity/contracts.js';
import type { ShopRole } from '../../db/schema/enums.js';

export interface ShopMembershipDto {
  shopId: string;
  role: ShopRole;
  shop: ShopContext;
}

export interface SessionDto {
  environment: string;
  user: {
    id: string;
    email: string;
    fullName: string | null;
    avatarUrl: string | null;
    status: 'pending_email' | 'active';
    emailConfirmedAt: string | null;
  };
  session: {
    id: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    recentAuthenticationExpiresAt: string | null;
    renewAfter: string;
  };
  memberships: ShopMembershipDto[];
}

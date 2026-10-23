import type { ShopRole } from '../../db/schema/enums.js';
import type { ShopContext } from './contracts.js';

export abstract class SessionVerifier {
  abstract verify(token: string): Promise<{ id: string; email: string | null } | null>;
}

export abstract class IdentityRepository {
  abstract findProfile(userId: string): Promise<{ fullName: string | null; avatarUrl: string | null } | null>;
  abstract findMembership(userId: string, shopId: string): Promise<{ shopId: string; role: ShopRole } | null>;
  abstract findShop(shopId: string): Promise<ShopContext | null>;
}

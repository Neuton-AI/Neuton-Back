import type { ShopRole } from '../../db/schema/enums.js';
import type { ShopContext } from './contracts.js';
import type { SessionRecord } from './session.service.js';

export abstract class SessionVerifier {
  abstract verify(secret: string): Promise<{ id: string; email: string | null; session?: SessionRecord } | null>;
}

export abstract class IdentityRepository {
  abstract findProfile(userId: string): Promise<{ fullName: string | null; avatarUrl: string | null } | null>;
  abstract findMembership(userId: string, shopId: string): Promise<{ shopId: string; role: ShopRole } | null>;
  abstract findShop(shopId: string): Promise<ShopContext | null>;
}

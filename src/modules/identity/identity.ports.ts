import type { ShopRole } from '../../db/schema/enums.js';
import type { ShopContext } from './contracts.js';
import type { VerifiedSessionReference } from './verified-session.js';

export abstract class SessionVerifier {
  abstract verify(secret: string): Promise<{ id: string; email: string | null; sessionId: string; status: 'active' | 'pending_email' } | null>;
}

export abstract class IdentityRepository {
  abstract findProfile(userId: string, session: VerifiedSessionReference): Promise<{ fullName: string | null; avatarUrl: string | null } | null>;
  abstract findMembership(userId: string, shopId: string, session: VerifiedSessionReference): Promise<{ shopId: string; role: ShopRole } | null>;
  abstract findShop(shopId: string, session: VerifiedSessionReference): Promise<ShopContext | null>;
}

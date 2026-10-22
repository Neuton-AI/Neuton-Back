import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { profiles, shopMembers, shops } from '../../db/schema/index.js';
import { IdentityRepository } from './identity.ports.js';

export class DrizzleIdentityRepository extends IdentityRepository {
  constructor(private readonly db: Database) { super(); }

  override async findProfile(userId: string) {
    const [profile] = await this.db.select({ fullName: profiles.fullName, avatarUrl: profiles.avatarUrl })
      .from(profiles).where(eq(profiles.id, userId)).limit(1);
    return profile ?? null;
  }

  override async findMembership(userId: string, shopId: string) {
    const [membership] = await this.db.select({ shopId: shopMembers.shopId, role: shopMembers.role })
      .from(shopMembers).where(and(eq(shopMembers.userId, userId), eq(shopMembers.shopId, shopId))).limit(1);
    return membership ?? null;
  }

  override async findShop(shopId: string) {
    const [shop] = await this.db.select({
      id: shops.id, name: shops.name, slug: shops.slug, currency: shops.currency, timezone: shops.timezone,
      storeAddress: shops.storeAddress, targetProfitMargin: shops.targetProfitMargin, hourlyLaborCost: shops.hourlyLaborCost,
      deliveryBaseFee: shops.deliveryBaseFee, deliveryRatePerKm: shops.deliveryRatePerKm,
    }).from(shops).where(eq(shops.id, shopId)).limit(1);
    return shop ?? null;
  }
}

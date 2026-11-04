import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { profiles, shops } from '../../db/schema/index.js';
import { IdentityRepository } from './identity.ports.js';
import { withShopTransaction, withUserTransaction } from '../../db/tenant-context.js';
import type { VerifiedSessionReference } from './verified-session.js';
import { forbidden } from '../../lib/errors.js';

export class DrizzleIdentityRepository extends IdentityRepository {
  constructor(private readonly db: Database) { super(); }

  override async findProfile(userId: string, session: VerifiedSessionReference) {
    if (userId !== session.userId) throw forbidden();
    return withUserTransaction(this.db, session, async scope => {
      const [profile] = await scope.database.select({ fullName: profiles.fullName, avatarUrl: profiles.avatarUrl })
        .from(profiles).where(eq(profiles.id, userId)).limit(1);
      return profile ?? null;
    });
  }

  override async findMembership(userId: string, shopId: string, session: VerifiedSessionReference) {
    if (userId !== session.userId) throw forbidden();
    return withShopTransaction(this.db, session, shopId, async scope => ({ shopId, role: scope.role }));
  }

  override async findShop(shopId: string, session: VerifiedSessionReference) {
    return withShopTransaction(this.db, session, shopId, async scope => {
      const [shop] = await scope.database.select({
      id: shops.id, name: shops.name, slug: shops.slug, currency: shops.currency, timezone: shops.timezone,
      storeAddress: shops.storeAddress, targetProfitMargin: shops.targetProfitMargin, hourlyLaborCost: shops.hourlyLaborCost,
      deliveryBaseFee: shops.deliveryBaseFee, deliveryRatePerKm: shops.deliveryRatePerKm,
    }).from(shops).where(eq(shops.id, shopId)).limit(1);
      return shop ?? null;
    });
  }
}

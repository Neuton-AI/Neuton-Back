import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { withShopTransaction, withUserTransaction } from '../../db/tenant-context.js';
import { createShop } from '../../db/shop-routines.js';
import { shops, profiles, auditLogs } from '../../db/schema/index.js';
import type { Shop, Profile } from '../../db/schema/index.js';
import { shopSlugBase } from '../../lib/slug.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import type { ActorContext } from '../identity/contracts.js';
import type { SessionActor } from '../identity/session.guard.js';
import type { z } from 'zod';
import type { ShopDto, ProfileDto, createShopSchema, shopSettingsSchema, updateProfileSchema } from './contracts.js';
export const SHOPS_DATABASE = Symbol('SHOPS_DATABASE');
export function mapShop(row: Shop): ShopDto {
  return { id: row.id, name: row.name, slug: row.slug, lastOrderNumber: row.lastOrderNumber,
    currency: row.currency, timezone: row.timezone, storeAddress: row.storeAddress,
    targetProfitMargin: row.targetProfitMargin, hourlyLaborCost: row.hourlyLaborCost,
    deliveryBaseFee: row.deliveryBaseFee, deliveryRatePerKm: row.deliveryRatePerKm,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function mapProfile(row: Profile): ProfileDto {
  return { id: row.id, fullName: row.fullName, avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function isSlugConflict(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; candidate && typeof candidate === 'object' && depth < 5; depth += 1) {
    const constraint = 'constraint_name' in candidate ? candidate.constraint_name : undefined;
    const name = constraint ?? ('constraint' in candidate ? candidate.constraint : undefined);
    if ('code' in candidate && candidate.code === '23505' && name === 'shops_slug_unique') return true;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return false;
}
@Injectable()
export class ShopsPersistence {
  constructor(@Inject(SHOPS_DATABASE) readonly database: Database) {}
  create(actor: SessionActor, body: z.infer<typeof createShopSchema>) {
    return withUserTransaction(this.database, actor.session, async scope => {
      if (scope.userId !== actor.user.id) throw forbidden();
      return mapShop(await createShop(scope, body, shopSlugBase(body.name)));
    });
  }
  find(actor: ActorContext) {
    return withShopTransaction(this.database, actor.session, actor.shop.id, async scope => {
      const [row] = await scope.database.select().from(shops).where(eq(shops.id, scope.shopId)).limit(1);
      if (!row) throw notFound('Shop not found');
      return mapShop(row);
    });
  }
  async update(actor: ActorContext, body: z.infer<typeof shopSettingsSchema>) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await withShopTransaction(this.database, actor.session, actor.shop.id, async scope => {
          if (scope.role !== 'owner' && scope.role !== 'admin') throw forbidden();
          const [current] = await scope.database.select().from(shops).where(eq(shops.id, scope.shopId)).limit(1);
          if (!current) throw notFound('Shop not found');
          const patch: Partial<typeof shops.$inferInsert> = { updatedAt: new Date() };
          if (body.name !== undefined) patch.name = body.name;
          if (body.storeAddress !== undefined) patch.storeAddress = body.storeAddress;
          if (body.currency !== undefined) patch.currency = body.currency;
          if (body.timezone !== undefined) patch.timezone = body.timezone;
          if (body.targetProfitMargin !== undefined) patch.targetProfitMargin = body.targetProfitMargin.toFixed(2);
          if (body.hourlyLaborCost !== undefined) patch.hourlyLaborCost = body.hourlyLaborCost.toFixed(2);
          if (body.deliveryBaseFee !== undefined) patch.deliveryBaseFee = body.deliveryBaseFee.toFixed(2);
          if (body.deliveryRatePerKm !== undefined) patch.deliveryRatePerKm = body.deliveryRatePerKm.toFixed(2);
          if (body.slug !== undefined) patch.slug = body.slug;
          else if (body.name !== undefined && body.name !== current.name) {
            patch.slug = shopSlugBase(body.name);
            if (attempt > 0) patch.slug += '-' + randomUUID().slice(0, 8);
          }
          const [updated] = await scope.database.update(shops).set(patch).where(eq(shops.id, scope.shopId)).returning();
          if (!updated) throw notFound('Shop not found');
          await scope.database.insert(auditLogs).values({ shopId: scope.shopId, userId: scope.userId,
            eventType: 'SHOP_UPDATED', resourceId: scope.shopId, ipAddress: actor.ipAddress ?? null,
            metadata: { fields: Object.keys(body) } });
          return mapShop(updated);
        });
      } catch (error) {
        if (!isSlugConflict(error)) throw error;
        if (body.slug !== undefined || body.name === undefined || attempt === 7) throw conflict('That shop slug is already taken');
      }
    }
    throw conflict('Unable to allocate a shop slug');
  }
  profile(actor: SessionActor) {
    return withUserTransaction(this.database, actor.session, async scope => {
      if (scope.userId !== actor.user.id) throw forbidden();
      const [row] = await scope.database.select().from(profiles).where(eq(profiles.id, scope.userId)).limit(1);
      if (!row) throw notFound('Profile not found');
      return mapProfile(row);
    });
  }
  updateProfile(actor: SessionActor, body: z.infer<typeof updateProfileSchema>) {
    return withUserTransaction(this.database, actor.session, async scope => {
      if (scope.userId !== actor.user.id) throw forbidden();
      const [row] = await scope.database.update(profiles).set({ ...body, updatedAt: new Date() })
        .where(eq(profiles.id, scope.userId)).returning();
      if (!row) throw notFound('Profile not found');
      return mapProfile(row);
    });
  }
}
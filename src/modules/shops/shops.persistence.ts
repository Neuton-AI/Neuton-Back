import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import {
  shops,
  profiles,
  shopMembers,
  type Shop,
  type Profile,
} from '../../db/schema/index.js';
import { generateUniqueSlug } from '../../lib/slug.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { AuthUser, ShopContext } from '../identity/contracts.js';
import type { z } from 'zod';
import type {
  ShopDto,
  ProfileDto,
  createShopSchema,
  shopSettingsSchema,
  updateProfileSchema,
} from './contracts.js';
export const SHOPS_DATABASE = Symbol('SHOPS_DATABASE');
export function mapShop(row: Shop): ShopDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    lastOrderNumber: row.lastOrderNumber,
    currency: row.currency,
    timezone: row.timezone,
    storeAddress: row.storeAddress,
    targetProfitMargin: row.targetProfitMargin,
    hourlyLaborCost: row.hourlyLaborCost,
    deliveryBaseFee: row.deliveryBaseFee,
    deliveryRatePerKm: row.deliveryRatePerKm,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function mapProfile(row: Profile): ProfileDto {
  return {
    id: row.id,
    fullName: row.fullName,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
@Injectable()
export class ShopsPersistence {
  constructor(@Inject(SHOPS_DATABASE) readonly database: Database = db) {}
  async memberships(userId: string) {
    const rows = await this.database
      .select({
        role: shopMembers.role,
        shopId: shops.id,
        shopName: shops.name,
        slug: shops.slug,
        currency: shops.currency,
        timezone: shops.timezone,
      })
      .from(shopMembers)
      .innerJoin(shops, eq(shops.id, shopMembers.shopId))
      .where(eq(shopMembers.userId, userId));
    return rows.map((row) => ({
      role: row.role,
      shop: {
        id: row.shopId,
        name: row.shopName,
        slug: row.slug,
        currency: row.currency,
        timezone: row.timezone,
      },
    }));
  }
  async create(user: AuthUser, body: z.infer<typeof createShopSchema>) {
    return this.database.transaction(async (tx) => {
      await tx
        .insert(profiles)
        .values({
          id: user.id,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
        })
        .onConflictDoUpdate({
          target: profiles.id,
          set: { updatedAt: new Date() },
        });
      const slug = await generateUniqueSlug(
        body.name,
        tx as unknown as Database,
      );
      const [shop] = await tx
        .insert(shops)
        .values({
          name: body.name,
          slug,
          storeAddress: body.storeAddress ?? null,
          targetProfitMargin: body.targetProfitMargin.toFixed(2),
          hourlyLaborCost: body.hourlyLaborCost.toFixed(2),
          deliveryBaseFee: body.deliveryBaseFee.toFixed(2),
          deliveryRatePerKm: body.deliveryRatePerKm.toFixed(2),
        })
        .returning();
      if (!shop) throw new Error('Shop insert returned no row');
      await tx
        .insert(shopMembers)
        .values({ shopId: shop.id, userId: user.id, role: 'owner' });
      return mapShop(shop);
    });
  }
  async find(id: string) {
    const [row] = await this.database
      .select()
      .from(shops)
      .where(eq(shops.id, id))
      .limit(1);
    if (!row) throw notFound('Shop not found');
    return mapShop(row);
  }
  async update(shop: ShopContext, body: z.infer<typeof shopSettingsSchema>) {
    const patch: Partial<typeof shops.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.storeAddress !== undefined) patch.storeAddress = body.storeAddress;
    if (body.currency !== undefined) patch.currency = body.currency;
    if (body.timezone !== undefined) patch.timezone = body.timezone;
    if (body.targetProfitMargin !== undefined) {
      patch.targetProfitMargin = body.targetProfitMargin.toFixed(2);
    }
    if (body.hourlyLaborCost !== undefined) {
      patch.hourlyLaborCost = body.hourlyLaborCost.toFixed(2);
    }
    if (body.deliveryBaseFee !== undefined) {
      patch.deliveryBaseFee = body.deliveryBaseFee.toFixed(2);
    }
    if (body.deliveryRatePerKm !== undefined) {
      patch.deliveryRatePerKm = body.deliveryRatePerKm.toFixed(2);
    }
    if (body.slug !== undefined && body.slug !== shop.slug) {
      const taken = await this.database
        .select({ id: shops.id })
        .from(shops)
        .where(and(eq(shops.slug, body.slug), eq(shops.id, shop.id)))
        .limit(1);
      const other = await this.database
        .select({ id: shops.id })
        .from(shops)
        .where(eq(shops.slug, body.slug))
        .limit(1);
      if (taken.length === 0 && other.length > 0) {
        throw conflict('That shop slug is already taken');
      }
      patch.slug = body.slug;
    } else if (
      body.name !== undefined &&
      body.name !== shop.name &&
      body.slug === undefined
    ) {
      patch.slug = await generateUniqueSlug(body.name, this.database, {
        excludeShopId: shop.id,
      });
    }

    const updated = await this.database
      .update(shops)
      .set(patch)
      .where(eq(shops.id, shop.id))
      .returning();

    if (!updated[0]) throw notFound('Shop not found');
    return mapShop(updated[0]);
  }
  async profile(id: string) {
    const [row] = await this.database
      .select()
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1);
    if (!row) throw notFound('Profile not found');
    return mapProfile(row);
  }
  async updateProfile(id: string, body: z.infer<typeof updateProfileSchema>) {
    const [row] = await this.database
      .insert(profiles)
      .values({ id, ...body })
      .onConflictDoUpdate({
        target: profiles.id,
        set: { ...body, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('Profile update returned no row');
    return mapProfile(row);
  }
}

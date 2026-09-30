import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import { profiles, shopMembers, shops } from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { generateUniqueSlug } from '../lib/slug.js';
import { supabaseAdmin } from '../lib/supabase-admin.js';
import { toNumber } from '../lib/money.js';

const shopSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and dashes')
    .optional(),
  storeAddress: z.string().trim().max(300).nullable().optional(),
  targetProfitMargin: z.coerce.number().min(0).max(999).optional(),
  hourlyLaborCost: z.coerce.number().min(0).max(100_000).optional(),
  deliveryBaseFee: z.coerce.number().min(0).max(100_000).optional(),
  deliveryRatePerKm: z.coerce.number().min(0).max(100_000).optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});

const createShopSchema = z.object({
  name: z.string().trim().min(2).max(120),
  storeAddress: z.string().trim().max(300).optional(),
  targetProfitMargin: z.coerce.number().min(0).max(999).default(35),
  hourlyLaborCost: z.coerce.number().min(0).max(100_000).default(18),
  deliveryBaseFee: z.coerce.number().min(0).max(100_000).default(3),
  deliveryRatePerKm: z.coerce.number().min(0).max(100_000).default(0.8),
});

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(120).nullable().optional(),
  avatarUrl: z.string().trim().url().max(500).nullable().optional(),
});

export const shopRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Session bootstrap: identity + every membership. The SPA calls this once
   * after login to decide between the onboarding and dashboard flows.
   */
  app.get('/session', { preHandler: [app.authenticate] }, async (request) => {
    const user = currentUser(request);
    const rows = await db
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
      .where(eq(shopMembers.userId, user.id));

    return {
      user,
      memberships: rows.map((row) => ({
        role: row.role,
        shop: {
          id: row.shopId,
          name: row.shopName,
          slug: row.slug,
          currency: row.currency,
          timezone: row.timezone,
        },
      })),
    };
  });

  /** Create a shop; the caller becomes its owner. */
  app.post(
    '/shops',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = createShopSchema.parse(request.body);
      const user = currentUser(request);

      await db
        .insert(profiles)
        .values({ id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl })
        .onConflictDoUpdate({
          target: profiles.id,
          set: { updatedAt: new Date() },
        });

      const slug = await generateUniqueSlug(body.name, db);

      const shop = await db.transaction(async (tx) => {
        const inserted = await tx
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

        const created = inserted[0];
        if (!created) throw new Error('Shop insert returned no row');

        await tx.insert(shopMembers).values({
          shopId: created.id,
          userId: user.id,
          role: 'owner',
        });

        return created;
      });

      await recordAuditSafe(app, {
        shopId: shop.id,
        userId: user.id,
        eventType: 'SHOP_CREATED',
        resourceId: shop.id,
        ipAddress: request.ip,
        metadata: { slug: shop.slug },
      });

      return reply.code(201).send({ shop });
    },
  );

  /** Shop settings shown on Profile → Shop. */
  app.get(
    '/shop',
    { preHandler: [app.authenticate, app.resolveShop] },
    async (request) => {
      const shop = currentShop(request);
      const row = await db.select().from(shops).where(eq(shops.id, shop.id)).limit(1);
      if (!row[0]) throw notFound('Shop not found');
      return { shop: row[0] };
    },
  );

  app.patch(
    '/shop',
    {
      preHandler: [
        app.authenticate,
        app.resolveShop,
        app.requireRole(['owner', 'admin']),
      ],
    },
    async (request) => {
      const shop = currentShop(request);
      const body = shopSettingsSchema.parse(request.body);

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
        const taken = await db
          .select({ id: shops.id })
          .from(shops)
          .where(and(eq(shops.slug, body.slug), eq(shops.id, shop.id)))
          .limit(1);
        const other = await db
          .select({ id: shops.id })
          .from(shops)
          .where(eq(shops.slug, body.slug))
          .limit(1);
        if (taken.length === 0 && other.length > 0) {
          throw conflict('That shop slug is already taken');
        }
        patch.slug = body.slug;
      } else if (body.name !== undefined && body.name !== shop.name && body.slug === undefined) {
        patch.slug = await generateUniqueSlug(body.name, db, { excludeShopId: shop.id });
      }

      const updated = await db
        .update(shops)
        .set(patch)
        .where(eq(shops.id, shop.id))
        .returning();

      await recordAuditSafe(app, {
        shopId: shop.id,
        userId: currentUser(request).id,
        eventType: 'SHOP_UPDATED',
        resourceId: shop.id,
        ipAddress: request.ip,
        metadata: { fields: Object.keys(body) },
      });

      return { shop: updated[0] };
    },
  );

  app.get(
    '/profile',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = currentUser(request);
      const row = await db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1);
      if (!row[0]) throw notFound('Profile not found');
      return { profile: row[0], email: user.email };
    },
  );

  app.patch(
    '/profile',
    { preHandler: [app.authenticate] },
    async (request) => {
      const user = currentUser(request);
      const body = updateProfileSchema.parse(request.body);

      const updated = await db
        .insert(profiles)
        .values({ id: user.id, ...body })
        .onConflictDoUpdate({ target: profiles.id, set: { ...body, updatedAt: new Date() } })
        .returning();

      return { profile: updated[0] };
    },
  );

  /** Password change is delegated to Supabase Auth (Argon2id). */
  app.post(
    '/profile/password',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = currentUser(request);
      const body = z
        .object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) })
        .parse(request.body);

      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email: user.email ?? '',
        password: body.currentPassword,
      });
      if (error || !data.user) {
        throw badRequest('Current password is incorrect');
      }

      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
        password: body.newPassword,
      });
      if (updateError) throw badRequest(updateError.message);

      return reply.send({ ok: true });
    },
  );

  /** Delivery preview used by the New Order screen (fee estimate card). */
  app.get(
    '/shop/delivery-preview',
    { preHandler: [app.authenticate, app.resolveShop] },
    async (request) => {
      const shop = currentShop(request);
      const { distance_km: distanceKm } = z
        .object({ distance_km: z.coerce.number().min(0) })
        .parse(request.query);

      const base = toNumber(shop.deliveryBaseFee);
      const rate = toNumber(shop.deliveryRatePerKm);
      const fee = Math.round((base + distanceKm * rate) * 100) / 100;

      return {
        distanceKm,
        baseFee: base,
        ratePerKm: rate,
        deliveryFee: fee,
      };
    },
  );
};

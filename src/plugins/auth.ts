import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { db } from '../db/client.js';
import { profiles, shopMembers, shops } from '../db/schema/index.js';
import type { ShopRole } from '../db/schema/enums.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { supabaseAdmin } from '../lib/supabase-admin.js';

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

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `requireAuth`. */
    user?: AuthUser;
    /** Populated by `requireShopContext`. */
    shop?: ShopContext;
    shopRole?: ShopRole;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    resolveShop: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      allowed: ShopRole[],
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

const requireAuthImpl: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', undefined);

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerToken(request);
    if (!token) {
      throw unauthorized('Missing bearer token');
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      throw unauthorized('Invalid or expired session');
    }

    const authUser = data.user;
    const rows = await db
      .select({
        id: profiles.id,
        fullName: profiles.fullName,
        avatarUrl: profiles.avatarUrl,
      })
      .from(profiles)
      .where(eq(profiles.id, authUser.id))
      .limit(1);

    request.user = {
      id: authUser.id,
      email: authUser.email ?? null,
      fullName: rows[0]?.fullName ?? null,
      avatarUrl: rows[0]?.avatarUrl ?? null,
    };
  });
};

/**
 * fp() is required: without it Fastify encapsulates this plugin and the
 * decorators land on a throwaway child instance, leaving `app.authenticate`
 * undefined in every route file.
 */
export const requireAuth: FastifyPluginAsync = fp(requireAuthImpl);

/**
 * Resolves the caller's active shop. An explicit `x-shop-id` header wins when
 * the user is a member of it; otherwise the user's first membership is used.
 */
const requireShopContextImpl: FastifyPluginAsync = async (app) => {
  app.decorateRequest('shop', undefined);
  app.decorateRequest('shopRole', undefined);

  app.decorate('resolveShop', async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = request.user;
    if (!user) throw unauthorized();

    const requestedShopId = request.headers['x-shop-id'];
    const explicitShopId =
      typeof requestedShopId === 'string' && requestedShopId.length > 0
        ? requestedShopId
        : undefined;

    const membershipRows = await db
      .select({ shopId: shopMembers.shopId, role: shopMembers.role })
      .from(shopMembers)
      .where(eq(shopMembers.userId, user.id));

    const memberships = membershipRows.filter(
      (row): row is { shopId: string; role: ShopRole } =>
        typeof row.shopId === 'string' && typeof row.role === 'string',
    );

    if (memberships.length === 0) {
      throw forbidden('This account is not a member of any shop yet');
    }

    const chosen = explicitShopId
      ? memberships.find((m) => m.shopId === explicitShopId)
      : memberships[0];

    if (!chosen) {
      throw forbidden('You do not have access to the requested shop');
    }

    const shopRows = await db
      .select()
      .from(shops)
      .where(inArray(shops.id, [chosen.shopId]))
      .limit(1);

    const shop = shopRows[0];
    if (!shop) {
      throw forbidden('Shop not found');
    }

    request.shop = {
      id: shop.id,
      name: shop.name,
      slug: shop.slug,
      currency: shop.currency,
      timezone: shop.timezone,
      storeAddress: shop.storeAddress,
      targetProfitMargin: shop.targetProfitMargin,
      hourlyLaborCost: shop.hourlyLaborCost,
      deliveryBaseFee: shop.deliveryBaseFee,
      deliveryRatePerKm: shop.deliveryRatePerKm,
    };
    request.shopRole = chosen.role;
  });

  /** Guard for owner/admin-only mutations (shop settings, members). */
  app.decorate('requireRole', (allowed: ShopRole[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.shopRole || !allowed.includes(request.shopRole)) {
        throw forbidden(`Requires one of the roles: ${allowed.join(', ')}`);
      }
    };
  });
};

export const requireShopContext: FastifyPluginAsync = fp(requireShopContextImpl);

export const authPlugins = fp(async (app) => {
  await app.register(requireAuth);
  await app.register(requireShopContext);
});

/** Type-safe accessor that fails loudly if a route forgets the guard. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function currentShop(request: FastifyRequest): ShopContext {
  if (!request.shop) throw forbidden('Shop context missing');
  return request.shop;
}

export function currentRole(request: FastifyRequest): ShopRole {
  if (!request.shopRole) throw forbidden('Shop role missing');
  return request.shopRole;
}

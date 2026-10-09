import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db, type Database } from '../db/client.js';
import { orderItems, orders, orderItemRecipeName, recipes, shops } from '../db/schema/index.js';
import { ORDER_STATUSES } from '../db/schema/enums.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { htmlFree } from '../lib/safeText.js';
import { money, quantity as qty, toNumber } from '../lib/money.js';
import {
  calculateDeliveryFee,
  calculateOrderTotals,
  calculateRetailPrice,
  calculateUnitCost,
} from '../lib/pricing.js';
import { recipeIngredients, inventoryItems } from '../db/schema/index.js';

const orderItemSchema = z.object({
  recipeId: z.string().uuid(),
  quantity: z.coerce.number().positive().max(100_000),
  /** Optional override; when omitted the recipe retail price is used. */
  unitPrice: z.coerce.number().min(0).nullable().optional(),
});

const createOrderSchema = z.object({
  customerName: htmlFree(z.string().trim().max(160)).nullable().optional(),
  orderDate: z.coerce.date().optional(),
  destinationAddress: htmlFree(z.string().trim().max(300)).nullable().optional(),
  deliveryDistanceKm: z.coerce.number().min(0).max(20_000).default(0),
  documentUrl: htmlFree(z.string().trim().max(500)).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
});

/**
 * Collaborators the order routes write through. Injected so the status
 * lifecycle can be exercised against a scripted database; production always
 * uses `defaultOrdersDeps`.
 */
export interface OrdersDeps {
  db: Database;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request override of `defaultOrdersDeps`. Production never sets it;
     * it exists so the create/transition endpoints can be tested without a
     * live Postgres.
     */
    ordersDeps?: OrdersDeps;
  }
}

export const defaultOrdersDeps: OrdersDeps = { db };

type PriceDb = Pick<Database, 'select'>;

async function priceOrderItems(
  database: PriceDb,
  shopId: string,
  shopMargin: string,
  hourlyLaborCost: string,
  items: { recipeId: string; quantity: number; unitPrice?: number | null }[],
) {
  const recipeIds = [...new Set(items.map((item) => item.recipeId))];
  if (recipeIds.length === 0) return [];

  const recipeRows = await database
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, shopId), inArray(recipes.id, recipeIds)));

  const ingredientRows = await database
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .where(eq(recipeIngredients.shopId, shopId));

  const byRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    const list = byRecipe.get(row.recipeId) ?? [];
    list.push(row);
    byRecipe.set(row.recipeId, list);
  }

  return items.map((item) => {
    const recipe = recipeRows.find((row) => row.id === item.recipeId);
    if (!recipe) throw notFound(`Recipe ${item.recipeId} not found`);

    const breakdown = calculateUnitCost({
      ingredients: (byRecipe.get(recipe.id) ?? []).map((row) => ({
        quantity: row.quantity,
        averageUnitCost: row.averageUnitCost,
      })),
      prepTimeMinutes: recipe.prepTimeMinutes,
      hourlyLaborCost,
      yieldQuantity: recipe.yieldQuantity,
    });

    const { retailPrice, appliedMarginPercent } = calculateRetailPrice(
      breakdown.unitCost,
      shopMargin,
      recipe.targetMarginPct,
    );

    return {
      recipeId: recipe.id,
      name: recipe.name,
      quantity: item.quantity,
      unitCost: breakdown.unitCost,
      unitPrice: item.unitPrice ?? retailPrice,
      appliedProfitMargin: appliedMarginPercent,
      retailPrice,
    };
  });
}

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [app.authenticate, app.resolveShop, app.requireRole(['owner', 'admin'])],
  };

  app.get('/orders', guards, async (request) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const query = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        search: z.string().trim().max(120).optional(),
        status: z.enum(ORDER_STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const conditions = [eq(orders.shopId, shop.id), isNull(orders.deletedAt)];
    if (query.from) conditions.push(sql`${orders.orderDate} >= ${query.from}`);
    if (query.to) conditions.push(sql`${orders.orderDate} <= ${query.to}`);
    if (query.search) {
      conditions.push(sql`${orders.customerName} ilike ${`%${query.search}%`}`);
    }
    if (query.status) conditions.push(eq(orders.status, query.status));

    const rows = await deps.db
      .select()
      .from(orders)
      .where(and(...conditions))
      // Secondary key is the invoice number (N-105): it is issued in creation
      // order, so within a day the listing is the sequence itself and ties no
      // longer depend on how `created_at` happens to sort.
      .orderBy(desc(orders.orderDate), desc(orders.orderNumber))
      .limit(query.limit)
      .offset(query.offset);

    const totalRows = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(...conditions));

    return {
      orders: rows.map((order) => ({
        ...order,
        netProfit: toNumber(order.totalAmount) - toNumber(order.deliveryFee) - toNumber(order.totalCost),
      })),
      total: totalRows[0]?.count ?? 0,
    };
  });

  app.get('/orders/:id', guards, async (request) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await deps.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shop.id), isNull(orders.deletedAt)))
      .limit(1);
    const order = rows[0];
    if (!order) throw notFound('Order not found');

    const items = await deps.db
      .select({
        id: orderItems.id,
        recipeId: orderItems.recipeId,
        // Snapshot first: renaming a recipe must not rewrite orders that
        // already went out, and a recipe with no row left must not take its
        // lines down with it.
        name: orderItemRecipeName,
        quantity: orderItems.quantity,
        unitCost: orderItems.unitCost,
        unitPrice: orderItems.unitPrice,
      })
      .from(orderItems)
      .leftJoin(recipes, eq(recipes.id, orderItems.recipeId))
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.id));

    return {
      order: {
        ...order,
        items,
        netProfit:
          toNumber(order.totalAmount) -
          toNumber(order.deliveryFee) -
          toNumber(order.totalCost),
      },
    };
  });

  /** Live pricing for the New Order screen before anything is persisted. */
  app.post('/orders/quote', guards, async (request) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const body = z
      .object({
        deliveryDistanceKm: z.coerce.number().min(0).default(0),
        items: z.array(orderItemSchema).min(1),
      })
      .parse(request.body);

    const priced = await priceOrderItems(
      deps.db,
      shop.id,
      shop.targetProfitMargin,
      shop.hourlyLaborCost,
      body.items,
    );

    const deliveryFee = calculateDeliveryFee(
      body.deliveryDistanceKm,
      shop.deliveryBaseFee,
      shop.deliveryRatePerKm,
    );

    const totals = calculateOrderTotals({
      items: priced.map((item) => ({
        quantity: item.quantity,
        unitCost: item.unitCost,
        unitPrice: item.unitPrice,
      })),
      deliveryFee,
    });

    return {
      items: priced,
      deliveryDistanceKm: body.deliveryDistanceKm,
      baseFee: toNumber(shop.deliveryBaseFee),
      ratePerKm: toNumber(shop.deliveryRatePerKm),
      ...totals,
    };
  });

  app.post('/orders', mutationGuards, async (request, reply) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = createOrderSchema.parse(request.body);

    const priced = await priceOrderItems(
      deps.db,
      shop.id,
      shop.targetProfitMargin,
      shop.hourlyLaborCost,
      body.items,
    );

    const deliveryFee = calculateDeliveryFee(
      body.deliveryDistanceKm,
      shop.deliveryBaseFee,
      shop.deliveryRatePerKm,
    );

    const totals = calculateOrderTotals({
      items: priced.map((item) => ({
        quantity: item.quantity,
        unitCost: item.unitCost,
        unitPrice: item.unitPrice,
      })),
      deliveryFee,
    });

    const created = await deps.db.transaction(async (tx) => {
      // One `UPDATE … RETURNING` both claims the next number and locks the
      // shop row until this transaction ends (N-105): concurrent creates queue
      // behind it, so they read the row the previous one wrote and can neither
      // duplicate nor skip a number. A create that rolls back takes its number
      // back with it, and nothing ever reuses a number that was issued.
      const [counter] = await tx
        .update(shops)
        .set({ lastOrderNumber: sql`${shops.lastOrderNumber} + 1` })
        .where(eq(shops.id, shop.id))
        .returning({ lastOrderNumber: shops.lastOrderNumber });
      if (!counter) throw new Error('Shop row missing while allocating order number');

      const inserted = await tx
        .insert(orders)
        .values({
          orderNumber: counter.lastOrderNumber,
          shopId: shop.id,
          userId: user.id,
          customerName: body.customerName ?? null,
          orderDate: body.orderDate ?? new Date(),
          destinationAddress: body.destinationAddress ?? null,
          deliveryDistanceKm: toNumber(body.deliveryDistanceKm).toFixed(2),
          deliveryFee: money(deliveryFee),
          appliedProfitMargin:
            priced[0]?.appliedProfitMargin !== undefined
              ? priced[0].appliedProfitMargin.toFixed(2)
              : null,
          totalCost: money(totals.totalCost),
          totalAmount: money(totals.totalAmount),
          documentUrl: body.documentUrl ?? null,
          // The client can never set the lifecycle state on create:
          // every order starts as `processing`.
          status: 'processing',
        })
        .returning();

      const order = inserted[0];
      if (!order) throw new Error('Order insert returned no row');

      await tx.insert(orderItems).values(
        priced.map((item) => ({
          shopId: shop.id,
          orderId: order.id,
          recipeId: item.recipeId,
          // Frozen here, while the catalog row is in hand: every later read
          // prefers this over the live name (N-107).
          recipeName: item.name,
          quantity: qty(item.quantity),
          unitCost: money(item.unitCost),
          unitPrice: money(item.unitPrice),
        })),
      );

      return order;
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'ORDER_CREATED',
      resourceId: created.id,
      ipAddress: request.ip,
      metadata: { totalAmount: totals.totalAmount, items: priced.length },
    });

    return reply.code(201).send({ order: created, totals });
  });

  /**
   * Human verification gate: `processing` → `delivered`.
   *
   * Any authenticated shop member may mark an order delivered (standard shop
   * guards, NOT owner/admin-only). Only the forward transition is allowed;
   * anything else is a 400, and cross-shop access reads as 404 so one shop
   * can never probe another shop's orders.
   */
  app.patch('/orders/:id/status', guards, async (request) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(ORDER_STATUSES) }).parse(request.body);

    if (status !== 'delivered') {
      throw badRequest('Only the processing -> delivered transition is supported');
    }

    const rows = await deps.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shop.id), isNull(orders.deletedAt)))
      .limit(1);
    const order = rows[0];
    if (!order) throw notFound('Order not found');
    if (order.status !== 'processing') {
      throw badRequest(`Order is already ${order.status}`);
    }

    const updated = await deps.db
      .update(orders)
      .set({ status: 'delivered' })
      .where(and(eq(orders.id, id), eq(orders.shopId, shop.id)))
      .returning();
    const next = updated[0];
    if (!next) throw notFound('Order not found');

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'ORDER_DELIVERED',
      resourceId: id,
      ipAddress: request.ip,
      metadata: { from: 'processing', to: 'delivered' },
    });

    return { order: next };
  });

  /**
   * Voids an order instead of deleting it (N-105).
   *
   * Invoicing wants a gapless per-shop sequence: a number that was issued has
   * to stay issued, so the row outlives the decision to cancel it and keeps its
   * number as a void. The row is locked first, the way `DELETE /receipts/:id`
   * does it, so "is it already void?" and the write are one decision; the write
   * is idempotent (a double tap answers the same way) and a missing or
   * cross-shop id reads as 404, like every other order write.
   */
  app.delete('/orders/:id', mutationGuards, async (request) => {
    const deps = request.ordersDeps ?? defaultOrdersDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const previousStatus = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.shopId, shop.id), isNull(orders.deletedAt)))
        .limit(1)
        .for('update');
      const order = rows[0];
      if (!order) throw notFound('Order not found');
      if (order.status === 'cancelled') return null;

      const updated = await tx
        .update(orders)
        .set({ status: 'cancelled' })
        .where(and(eq(orders.id, id), eq(orders.shopId, shop.id)))
        .returning({ id: orders.id });
      if (!updated[0]) throw notFound('Order not found');
      return order.status;
    });

    if (previousStatus) {
      await recordAuditSafe(app, {
        shopId: shop.id,
        userId: user.id,
        eventType: 'ORDER_CANCELLED',
        resourceId: id,
        ipAddress: request.ip,
        metadata: { from: previousStatus, to: 'cancelled' },
      });
    }

    return { ok: true };
  });
};

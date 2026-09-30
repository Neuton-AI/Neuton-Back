import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import {
  inventoryItems,
  orderItems,
  orders,
  receipts,
  recipes,
} from '../db/schema/index.js';
import { currentShop } from '../plugins/auth.js';
import { toNumber } from '../lib/money.js';
import { average, median } from '../lib/pricing.js';

export type Period = '7d' | '30d' | '90d' | '12m';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

function periodStart(period: Period, now = new Date()): Date {
  const days = PERIOD_DAYS[period];
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

function previousPeriodStart(period: Period, now = new Date()): Date {
  const start = periodStart(period, now);
  start.setUTCDate(start.getUTCDate() - PERIOD_DAYS[period]);
  return start;
}

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };

  /** Everything the Dashboard needs in one round trip. */
  app.get('/analytics/dashboard', guards, async (request) => {
    const shop = currentShop(request);
    const { period } = z
      .object({ period: z.enum(['7d', '30d', '90d', '12m']).default('30d') })
      .parse(request.query);

    const now = new Date();
    const start = periodStart(period, now);
    const previousStart = previousPeriodStart(period, now);

    const [orderTotals, expenseTotals, previousOrderTotals, previousExpenseTotals] =
      await Promise.all([
        db
          .select({
            revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
            cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
            delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(orders)
          .where(and(eq(orders.shopId, shop.id), sql`${orders.orderDate} >= ${start}`)),
        db
          .select({ expenses: sql<string>`coalesce(sum(${receipts.totalAmount}),0)` })
          .from(receipts)
          .where(
            and(
              eq(receipts.shopId, shop.id),
              eq(receipts.status, 'completed'),
              sql`${receipts.receiptDate} is not null and ${receipts.receiptDate} >= ${start}`,
            ),
          ),
        db
          .select({
            revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
            delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
            cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.shopId, shop.id),
              sql`${orders.orderDate} >= ${previousStart}`,
              sql`${orders.orderDate} < ${start}`,
            ),
          ),
        db
          .select({ expenses: sql<string>`coalesce(sum(${receipts.totalAmount}),0)` })
          .from(receipts)
          .where(
            and(
              eq(receipts.shopId, shop.id),
              eq(receipts.status, 'completed'),
              sql`${receipts.receiptDate} is not null and ${receipts.receiptDate} >= ${previousStart}`,
              sql`${receipts.receiptDate} < ${start}`,
            ),
          ),
      ]);

    const revenue = toNumber(orderTotals[0]?.revenue);
    const delivery = toNumber(orderTotals[0]?.delivery);
    const productionCost = toNumber(orderTotals[0]?.cost);
    const expenses = toNumber(expenseTotals[0]?.expenses);

    // Net profit = billed revenue − delivery payouts − production cost − recorded expenses.
    const netProfit = revenue - delivery - productionCost - expenses;
    const previousRevenue = toNumber(previousOrderTotals[0]?.revenue);
    const previousProfit =
      previousRevenue -
      toNumber(previousOrderTotals[0]?.delivery) -
      toNumber(previousOrderTotals[0]?.cost) -
      toNumber(previousExpenseTotals[0]?.expenses);

    const trendPercent = (current: number, previous: number) => {
      if (previous === 0) return current === 0 ? 0 : 100;
      return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
    };

    const [topItem, orderStats, lowStock, graph] = await Promise.all([
      topPerformingItem(shop.id, start),
      orderProfitStats(shop.id, start),
      lowStockItems(shop.id),
      profitGraph(shop.id, period, now),
    ]);

    return {
      period,
      range: { from: start.toISOString(), to: now.toISOString() },
      summary: {
        revenue,
        expenses,
        deliveryFees: delivery,
        productionCost,
        netProfit,
        orderCount: orderTotals[0]?.count ?? 0,
        profitMarginPercent: revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0,
      },
      trend: {
        revenuePercent: trendPercent(revenue, previousRevenue),
        profitPercent: trendPercent(netProfit, previousProfit),
        expensesPercent: trendPercent(expenses, toNumber(previousExpenseTotals[0]?.expenses)),
      },
      graph,
      topItem,
      orderProfitability: orderStats,
      lowStock,
    };
  });

  app.get('/analytics/recent-orders', guards, async (request) => {
    const shop = currentShop(request);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(20).default(5) })
      .parse(request.query);

    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.shopId, shop.id))
      .orderBy(desc(orders.orderDate))
      .limit(limit);

    return {
      orders: rows.map((order) => ({
        ...order,
        netProfit:
          toNumber(order.totalAmount) -
          toNumber(order.deliveryFee) -
          toNumber(order.totalCost),
      })),
    };
  });

  app.get('/analytics/inventory-value', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select({
        value: sql<string>`coalesce(sum(${inventoryItems.currentQuantity} * ${inventoryItems.averageUnitCost}),0)`,
        units: sql<number>`count(*)::int`,
      })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.shopId, shop.id), eq(inventoryItems.isActive, true)));

    return { inventoryValue: toNumber(rows[0]?.value), trackedItems: rows[0]?.units ?? 0 };
  });
};

async function topPerformingItem(shopId: string, start: Date) {
  const rows = await db
    .select({
      recipeId: recipes.id,
      name: recipes.name,
      imageUrl: recipes.imageUrl,
      unitsSold: sql<string>`coalesce(sum(${orderItems.quantity}),0)`,
      revenue: sql<string>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitPrice}),0)`,
      cost: sql<string>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitCost}),0)`,
    })
    .from(orderItems)
    .innerJoin(recipes, eq(recipes.id, orderItems.recipeId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.shopId, shopId), sql`${orders.orderDate} >= ${start}`))
    .groupBy(recipes.id, recipes.name, recipes.imageUrl)
    .orderBy(desc(sql`coalesce(sum(${orderItems.quantity}),0)`))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const revenue = toNumber(row.revenue);
  const cost = toNumber(row.cost);
  return {
    recipeId: row.recipeId,
    name: row.name,
    imageUrl: row.imageUrl,
    unitsSold: toNumber(row.unitsSold),
    revenue,
    netProfit: Math.round((revenue - cost) * 100) / 100,
  };
}

async function orderProfitStats(shopId: string, start: Date) {
  const rows = await db
    .select({
      netProfit: sql<string>`${orders.totalAmount} - ${orders.deliveryFee} - ${orders.totalCost}`,
    })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), sql`${orders.orderDate} >= ${start}`));

  const profits = rows.map((row) => toNumber(row.netProfit));
  return {
    average: average(profits),
    median: median(profits),
    sampleSize: profits.length,
  };
}

async function lowStockItems(shopId: string) {
  const rows = await db
    .select({
      id: inventoryItems.id,
      name: inventoryItems.name,
      unit: inventoryItems.unit,
      currentQuantity: inventoryItems.currentQuantity,
      reorderLevel: inventoryItems.reorderLevel,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.shopId, shopId),
        eq(inventoryItems.isActive, true),
        sql`${inventoryItems.reorderLevel} is not null and ${inventoryItems.currentQuantity} <= ${inventoryItems.reorderLevel}`,
      ),
    )
    .orderBy(desc(inventoryItems.currentQuantity))
    .limit(5);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    unit: row.unit,
    currentQuantity: toNumber(row.currentQuantity),
    reorderLevel: toNumber(row.reorderLevel),
  }));
}

/** Daily net-profit series for the Dashboard graph. */
async function profitGraph(shopId: string, period: Period, now: Date) {
  const start = periodStart(period, now);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD')`,
      revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
      delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
      cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
    })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), sql`${orders.orderDate} >= ${start}`))
    .groupBy(sql`date_trunc('day', ${orders.orderDate} at time zone 'UTC')`)
    .orderBy(sql`date_trunc('day', ${orders.orderDate} at time zone 'UTC')`);

  const expenses = await db
    .select({
      day: sql<string>`to_char(${receipts.receiptDate}, 'YYYY-MM-DD')`,
      total: sql<string>`coalesce(sum(${receipts.totalAmount}),0)`,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.shopId, shopId),
        eq(receipts.status, 'completed'),
        sql`${receipts.receiptDate} is not null and ${receipts.receiptDate} >= ${start}`,
      ),
    )
    .groupBy(receipts.receiptDate)
    .orderBy(receipts.receiptDate);

  const expenseByDay = new Map(
    expenses.map((row) => [row.day, toNumber(row.total)]),
  );

  return rows.map((row) => {
    const revenue = toNumber(row.revenue);
    const delivery = toNumber(row.delivery);
    const cost = toNumber(row.cost);
    const dayExpense = expenseByDay.get(row.day) ?? 0;
    return {
      date: row.day,
      revenue,
      expenses: dayExpense,
      netProfit: Math.round((revenue - delivery - cost - dayExpense) * 100) / 100,
    };
  });
}

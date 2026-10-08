import { z } from 'zod';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db, type Database } from '../db/client.js';
import {
  inventoryItems,
  orderItems,
  orderItemRecipeName,
  orders,
  receipts,
  recipes,
} from '../db/schema/index.js';
import { currentShop } from '../plugins/auth.js';
import { toNumber } from '../lib/money.js';
import { average, median } from '../lib/pricing.js';

export type Period = '7d' | '30d' | '90d' | '12m';

export const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

/**
 * Collaborators the reporting queries run against. Injected so the aggregations
 * can be tested against scripted rows instead of a live database; production
 * always uses `defaultAnalyticsDeps`.
 */
export interface AnalyticsDeps {
  db: Database;
  /** Injected so a test can pin "now" instead of depending on the wall clock. */
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request override of `defaultAnalyticsDeps`. Production never sets it;
     * it exists so the aggregations can be tested against scripted rows.
     */
    analyticsDeps?: AnalyticsDeps;
  }
}

export const defaultAnalyticsDeps: AnalyticsDeps = { db, now: () => new Date() };

export function periodStart(period: Period, now: Date = new Date()): Date {
  const days = PERIOD_DAYS[period];
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

export function previousPeriodStart(period: Period, now: Date = new Date()): Date {
  const start = periodStart(period, now);
  start.setUTCDate(start.getUTCDate() - PERIOD_DAYS[period]);
  return start;
}

/** Share change as a percentage. A zero baseline reports 100% rather than Infinity. */
export function trendPercent(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Billed revenue − delivery payouts − production cost − recorded expenses. */
export function netProfitOf(revenue: number, delivery: number, cost: number, expenses: number): number {
  return revenue - delivery - cost - expenses;
}

/**
 * The day a receipt's spend is booked against.
 *
 * `receipt_date` is nullable — the vision model often cannot read a date off the
 * document — and a window filter of `receipt_date >= $from` then drops the row
 * silently, because `null >= $from` is null rather than true. Undated spend is
 * booked on the day the shop recorded the receipt instead: deterministic, inside a
 * real window, and still counted against net profit.
 */
export const receiptSpendDay = sql`coalesce(${receipts.receiptDate}, (${receipts.createdAt} at time zone 'UTC')::date)`;

/**
 * Window filter for receipt spend. Never mention `receipt_date is not null`: an
 * undated receipt belongs in the totals, not in a bucket nobody can see.
 *
 * The bounds are bound as ISO strings and cast, never as `Date` objects: the
 * `postgres` driver refuses to serialize a `Date` for the parameter type the
 * server infers here, so a real dashboard request crashed with
 * `ERR_INVALID_ARG_TYPE` on every window predicate. The cast reproduces the
 * exact UTC-midnight semantics `periodStart` already computes.
 */
export function spentSince(start: Date, before?: Date): SQL {
  return before === undefined
    ? sql`${receiptSpendDay} >= ${start.toISOString()}::date`
    : sql`${receiptSpendDay} >= ${start.toISOString()}::date and ${receiptSpendDay} < ${utcInstant(before)}::date`;
}

/** ISO instant for a window bound; see the note on `spentSince`. */
function utcInstant(date: Date): string {
  return date.toISOString();
}

/**
 * Expense total for a window, plus how much of it had no date on the receipt.
 *
 * The undated counters only see rows that move money: a verified receipt whose
 * total is null or 0.00 sits inside `expenses` contributing nothing, so counting
 * it would report undated spend that does not exist (`count: 1, amount: 0`).
 */
export const expenseTotalsFields = {
  expenses: sql<string>`coalesce(sum(${receipts.totalAmount}),0)`,
  undatedCount: sql<number>`count(*) filter (where ${receipts.receiptDate} is null and coalesce(${receipts.totalAmount},0) <> 0)::int`,
  undatedAmount: sql<string>`coalesce(sum(${receipts.totalAmount}) filter (where ${receipts.receiptDate} is null and coalesce(${receipts.totalAmount},0) <> 0),0)`,
};

/**
 * Receipts that count as spend.
 *
 * As of N-28 the worker only extracts, so a receipt sits at `unverified` until a
 * person approves it — and money spent but not yet approved is not money spent.
 * An `unverified` receipt therefore contributes nothing to any total here.
 *
 * This is the one predicate that has to agree with the backfill in
 * `0007_receipt_status_switchover.sql`: history was rewritten `completed` →
 * `verified`, so filtering on `verified` reproduces exactly the rows the old
 * `completed` filter matched. The two are asserted equal over real shop data in
 * that migration's PR, because getting it wrong does not throw — it quietly
 * reports plausible zeros. Exported so `scripts/analytics.test.ts` can pin the
 * predicate itself, which is the only kind of failure this can produce.
 */
export const countedAsSpend = eq(receipts.status, 'verified');

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };

  /** Everything the Dashboard needs in one round trip. */
  app.get('/analytics/dashboard', guards, async (request) => {
    const deps = request.analyticsDeps ?? defaultAnalyticsDeps;
    const shop = currentShop(request);
    const { period } = z
      .object({ period: z.enum(['7d', '30d', '90d', '12m']).default('30d') })
      .parse(request.query);

    const now = deps.now();
    const start = periodStart(period, now);
    const previousStart = previousPeriodStart(period, now);

    const [orderTotals, expenseTotals, previousOrderTotals, previousExpenseTotals] =
      await Promise.all([
        deps.db
          .select({
            revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
            cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
            delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
            count: sql<number>`count(*)::int`,
          })
          .from(orders)
          .where(and(eq(orders.shopId, shop.id), isNull(orders.deletedAt), sql`${orders.orderDate} >= ${utcInstant(start)}::timestamptz`)),
        deps.db
          .select(expenseTotalsFields)
          .from(receipts)
          .where(
            and(
              eq(receipts.shopId, shop.id),
              countedAsSpend,
              spentSince(start),
            ),
          ),
        deps.db
          .select({
            revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
            delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
            cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.shopId, shop.id),
              isNull(orders.deletedAt),
              sql`${orders.orderDate} >= ${utcInstant(previousStart)}::timestamptz`,
              sql`${orders.orderDate} < ${utcInstant(start)}::timestamptz`,
            ),
          ),
        deps.db
          .select(expenseTotalsFields)
          .from(receipts)
          .where(
            and(
              eq(receipts.shopId, shop.id),
              countedAsSpend,
              spentSince(previousStart, start),
            ),
          ),
      ]);

    const revenue = toNumber(orderTotals[0]?.revenue);
    const delivery = toNumber(orderTotals[0]?.delivery);
    const productionCost = toNumber(orderTotals[0]?.cost);
    const expenses = toNumber(expenseTotals[0]?.expenses);

    const netProfit = netProfitOf(revenue, delivery, productionCost, expenses);
    const previousRevenue = toNumber(previousOrderTotals[0]?.revenue);
    const previousProfit = netProfitOf(
      previousRevenue,
      toNumber(previousOrderTotals[0]?.delivery),
      toNumber(previousOrderTotals[0]?.cost),
      toNumber(previousExpenseTotals[0]?.expenses),
    );
    const previousExpenses = toNumber(previousExpenseTotals[0]?.expenses);

    const [topItem, orderStats, lowStock, graph] = await Promise.all([
      topPerformingItem(deps, shop.id, start),
      orderProfitStats(deps, shop.id, start),
      lowStockItems(deps, shop.id),
      profitGraph(deps, shop.id, period, now),
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
        /**
         * Spend that is inside the totals above but had no date on the document,
         * so it was booked on its upload day. Surfaced so the UI can say so
         * instead of the total quietly disagreeing with the receipts list.
         */
        undatedExpenses: {
          count: expenseTotals[0]?.undatedCount ?? 0,
          amount: toNumber(expenseTotals[0]?.undatedAmount),
        },
      },
      trend: {
        revenuePercent: trendPercent(revenue, previousRevenue),
        profitPercent: trendPercent(netProfit, previousProfit),
        expensesPercent: trendPercent(expenses, previousExpenses),
      },
      graph,
      topItem,
      orderProfitability: orderStats,
      lowStock,
    };
  });

  app.get('/analytics/recent-orders', guards, async (request) => {
    const deps = request.analyticsDeps ?? defaultAnalyticsDeps;
    const shop = currentShop(request);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(20).default(5) })
      .parse(request.query);

    const rows = await deps.db
      .select()
      .from(orders)
      .where(and(eq(orders.shopId, shop.id), isNull(orders.deletedAt)))
      .orderBy(desc(orders.orderDate))
      .limit(limit);

    return {
      orders: rows.map((order) => ({
        ...order,
        netProfit: netProfitOf(
          toNumber(order.totalAmount),
          toNumber(order.deliveryFee),
          toNumber(order.totalCost),
          0,
        ),
      })),
    };
  });

  app.get('/analytics/inventory-value', guards, async (request) => {
    const deps = request.analyticsDeps ?? defaultAnalyticsDeps;
    const shop = currentShop(request);
    const rows = await deps.db
      .select({
        value: sql<string>`coalesce(sum(${inventoryItems.currentQuantity} * ${inventoryItems.averageUnitCost}),0)`,
        units: sql<number>`count(*)::int`,
      })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.shopId, shop.id), eq(inventoryItems.isActive, true)));

    return { inventoryValue: toNumber(rows[0]?.value), trackedItems: rows[0]?.units ?? 0 };
  });
};

async function topPerformingItem(deps: AnalyticsDeps, shopId: string, start: Date) {
  const rows = await deps.db
    .select({
      // Keyed off the line, not the recipe: a recipe with no row left still has
      // sales to report, and its label comes from the snapshot (N-107).
      recipeId: orderItems.recipeId,
      name: orderItemRecipeName,
      imageUrl: recipes.imageUrl,
      unitsSold: sql<string>`coalesce(sum(${orderItems.quantity}),0)`,
      revenue: sql<string>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitPrice}),0)`,
      cost: sql<string>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitCost}),0)`,
    })
    .from(orderItems)
    .leftJoin(recipes, eq(recipes.id, orderItems.recipeId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.shopId, shopId), isNull(orders.deletedAt), sql`${orders.orderDate} >= ${utcInstant(start)}::timestamptz`))
    .groupBy(orderItems.recipeId, orderItemRecipeName, recipes.imageUrl)
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

async function orderProfitStats(deps: AnalyticsDeps, shopId: string, start: Date) {
  const rows = await deps.db
    .select({
      netProfit: sql<string>`${orders.totalAmount} - ${orders.deliveryFee} - ${orders.totalCost}`,
    })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), isNull(orders.deletedAt), sql`${orders.orderDate} >= ${utcInstant(start)}::timestamptz`));

  const profits = rows.map((row) => toNumber(row.netProfit));
  return {
    average: average(profits),
    median: median(profits),
    sampleSize: profits.length,
  };
}

async function lowStockItems(deps: AnalyticsDeps, shopId: string) {
  const rows = await deps.db
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
async function profitGraph(deps: AnalyticsDeps, shopId: string, period: Period, now: Date) {
  const start = periodStart(period, now);

  const rows = await deps.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD')`,
      revenue: sql<string>`coalesce(sum(${orders.totalAmount}),0)`,
      delivery: sql<string>`coalesce(sum(${orders.deliveryFee}),0)`,
      cost: sql<string>`coalesce(sum(${orders.totalCost}),0)`,
    })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), isNull(orders.deletedAt), sql`${orders.orderDate} >= ${utcInstant(start)}::timestamptz`))
    .groupBy(sql`date_trunc('day', ${orders.orderDate} at time zone 'UTC')`)
    .orderBy(sql`date_trunc('day', ${orders.orderDate} at time zone 'UTC')`);

  const expenses = await deps.db
    .select({
      day: sql<string>`to_char(${receiptSpendDay}, 'YYYY-MM-DD')`,
      total: sql<string>`coalesce(sum(${receipts.totalAmount}),0)`,
    })
    .from(receipts)
    .where(and(eq(receipts.shopId, shopId), countedAsSpend, spentSince(start)))
    .groupBy(receiptSpendDay)
    .orderBy(receiptSpendDay);

  /**
   * Every day with money in it, not only the days with sales: an expense day with
   * no orders — including the upload day of an undated receipt — still moves net
   * profit, so dropping it would leave the series short of `summary.expenses`.
   *
   * A day whose net profit rounds to 0.00 is not money in it and never becomes a
   * point — whether it is a day with no movement at all, or a day where revenue
   * exactly cancelled out cost, delivery and expenses. Red days and green days
   * both stay; only the flat zero goes.
   */
  const byDay = new Map<string, { revenue: number; delivery: number; cost: number; expenses: number }>();
  for (const row of rows) {
    byDay.set(row.day, {
      revenue: toNumber(row.revenue),
      delivery: toNumber(row.delivery),
      cost: toNumber(row.cost),
      expenses: 0,
    });
  }
  for (const row of expenses) {
    const day = byDay.get(row.day) ?? { revenue: 0, delivery: 0, cost: 0, expenses: 0 };
    byDay.set(row.day, { ...day, expenses: day.expenses + toNumber(row.total) });
  }

  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, day]) => ({
      date,
      revenue: day.revenue,
      expenses: day.expenses,
      netProfit: Math.round(netProfitOf(day.revenue, day.delivery, day.cost, day.expenses) * 100) / 100,
    }))
    .filter((day) => day.netProfit !== 0);
}

import { sql } from 'drizzle-orm';
import { orderItems, orders } from '../db/schema/orders.js';
import { round, toNumber } from './money.js';

const headerProfit = sql`${orders.totalAmount} - ${orders.deliveryFee} - ${orders.totalCost}`;
const lineMargin = sql`(${orderItems.unitPrice} - ${orderItems.unitCost}) * ${orderItems.quantity}`;

/** The correction preserves production-cost/revenue reporting as separate facts. */
export const partialLineProfitCorrection = sql`case when ${orderItems.costComplete} is false then ${lineMargin} else 0 end`;

// Only pre-snapshot partial orders need this fallback. Unknown/complete legacy
// orders retain their stored header accounting, including historical overrides.
const legacyProfit = sql`(select case when bool_or(${orderItems.costComplete} is false)
  then round(coalesce(sum(${lineMargin}) filter (where ${orderItems.costComplete} is distinct from false), 0), 2)
  else ${headerProfit} end
  from ${orderItems}
  where ${orderItems.orderId} = ${orders.id} and ${orderItems.shopId} = ${orders.shopId})`;

export const storedOrderProfit = sql<string>`coalesce(${orders.profitSnapshot}, ${legacyProfit})`;
export const orderProfitCorrection = sql<string>`(${headerProfit} - ${storedOrderProfit})`;

export function readOrderProfit(order: {
  totalAmount: string; deliveryFee: string; totalCost: string;
  profitSnapshot?: string | null;
  profitCorrection?: string | number;
}): number {
  if (order.profitSnapshot !== undefined && order.profitSnapshot !== null) return toNumber(order.profitSnapshot);
  const header = toNumber(order.totalAmount) - toNumber(order.deliveryFee) - toNumber(order.totalCost);
  const correction = toNumber(order.profitCorrection);
  return round(header - correction, 2);
}

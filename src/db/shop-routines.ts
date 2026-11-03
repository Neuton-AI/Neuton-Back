import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';
import type { createShopSchema } from '../modules/shops/contracts.js';
import type { ShopRole } from './schema/enums.js';
import { shops } from './schema/identity.js';
import type { ShopTransaction, UserTransaction } from './types.js';

export async function createShop(scope: UserTransaction, input: z.infer<typeof createShopSchema>, slug: string) {
  const rows = await scope.database.execute<{ id: string }>(sql`
    select id from app_private.create_shop(${input.name},${slug},${input.storeAddress ?? null},
      ${input.targetProfitMargin},${input.hourlyLaborCost},${input.deliveryBaseFee},${input.deliveryRatePerKm})`);
  const id = rows[0]?.id;
  if (!id) throw new AppError(503, 'SHOP_CREATION_UNAVAILABLE', 'Unable to create the shop');
  const [shop] = await scope.database.select().from(shops).where(eq(shops.id, id)).limit(1);
  if (!shop) throw new AppError(503, 'SHOP_CREATION_UNAVAILABLE', 'Unable to resolve the created shop');
  return shop;
}

/** Internal membership use case only; this introduces no public HTTP route. */
export async function changeShopMembership(scope: UserTransaction, shopId: string, userId: string, role: ShopRole | null): Promise<void> {
  await scope.database.execute(sql`select app_private.change_membership(${shopId}::uuid,${userId}::uuid,${role})`);
}

export async function nextOrderNumber(scope: ShopTransaction): Promise<number> {
  const rows = await scope.database.execute<{ value: number }>(sql`select app_private.next_order_number() as value`);
  const value = rows[0]?.value;
  if (!value || !Number.isSafeInteger(value)) throw new AppError(503, 'ORDER_NUMBER_UNAVAILABLE', 'Unable to allocate an order number');
  return value;
}

export async function markOrderDelivered(scope: ShopTransaction, orderId: string): Promise<boolean> {
  const rows = await scope.database.execute<{ changed: boolean }>(sql`select app_private.mark_order_delivered(${orderId}::uuid) as changed`);
  return rows[0]?.changed === true;
}

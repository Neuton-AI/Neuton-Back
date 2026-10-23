import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import {
  inventoryAdjustmentBatches,
  inventoryItems,
  type InventoryAdjustmentResult,
} from '../db/schema/index.js';
import { conflict, forbidden } from './errors.js';

export const inventoryAdjustmentKeySchema = z.string().uuid();
export const inventoryAdjustmentSchema = z.object({
  adjustments: z
    .array(
      z.object({
        inventoryItemId: z.string().uuid(),
        deltaQuantity: z.coerce.number().finite(),
      }),
    )
    .min(1)
    .max(200)
    .refine(
      (items) =>
        new Set(items.map((item) => item.inventoryItemId)).size ===
        items.length,
      'Each inventory item must appear once',
    ),
});

export async function adjustInventory(
  database: Database,
  input: {
    shopId: string;
    userId: string;
    key: string;
    adjustments: z.infer<typeof inventoryAdjustmentSchema>['adjustments'];
  },
): Promise<InventoryAdjustmentResult> {
  const { shopId, userId, adjustments } = input;
  const key = inventoryAdjustmentKeySchema.parse(input.key);
  const requestHash = createHash('sha256')
    .update(JSON.stringify(adjustments))
    .digest('hex');
  return database.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(inventoryAdjustmentBatches)
      .values({ shopId, id: key, userId, requestHash })
      .onConflictDoNothing()
      .returning({ id: inventoryAdjustmentBatches.id });
    if (!claimed) {
      const [previous] = await tx
        .select()
        .from(inventoryAdjustmentBatches)
        .where(
          and(
            eq(inventoryAdjustmentBatches.shopId, shopId),
            eq(inventoryAdjustmentBatches.id, key),
          ),
        );
      if (
        !previous ||
        previous.userId !== userId ||
        previous.requestHash !== requestHash
      )
        throw conflict(
          'Idempotency key was already used for a different stock adjustment',
        );
      if (!previous.response)
        throw conflict('Stock adjustment is still pending');
      return previous.response;
    }
    const ids = adjustments.map((item) => item.inventoryItemId);
    const owned = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.shopId, shopId), inArray(inventoryItems.id, ids)),
      )
      .orderBy(asc(inventoryItems.id))
      .for('update');
    if (owned.length !== ids.length)
      throw forbidden('Every inventory item must belong to this shop');
    for (const adjustment of adjustments) {
      await tx
        .update(inventoryItems)
        .set({
          currentQuantity: sql`greatest(${inventoryItems.currentQuantity} + ${adjustment.deltaQuantity}, 0)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryItems.id, adjustment.inventoryItemId),
            eq(inventoryItems.shopId, shopId),
          ),
        );
    }
    const response = { adjusted: ids.length, ids };
    await tx
      .update(inventoryAdjustmentBatches)
      .set({ response })
      .where(
        and(
          eq(inventoryAdjustmentBatches.shopId, shopId),
          eq(inventoryAdjustmentBatches.id, key),
        ),
      );
    return response;
  });
}

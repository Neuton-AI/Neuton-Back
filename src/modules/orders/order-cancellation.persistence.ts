import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { finishedStock, mediaUploads, orderItems, orderPayments, orders, recipes } from '../../db/schema/index.js';
import { recordAudit } from '../../lib/audit.js';
import { previewStoragePath, sourceStoragePaths } from '../../lib/documentPreviews.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { scheduleObjectDeletions } from '../../lib/storageCleanup.js';
import type { OrdersTransaction } from './orders.persistence.js';

export type CancellationDecision = { madeItems: boolean; stockItems: { orderItemId: string; quantity: number }[] };

async function unsharedPaths(tx: OrdersTransaction, shopId: string, paths: string[]) {
  if (!paths.length) return [];
  const candidates = sql.join(paths.map(path => sql`${path}`), sql`, `);
  const previewSuffix = previewStoragePath('');
  const rows = await tx.execute<{ path: string }>(sql`
    SELECT candidate.path FROM unnest(ARRAY[${candidates}]::text[]) AS candidate(path)
    WHERE NOT EXISTS (
      SELECT 1 FROM media_uploads upload
      CROSS JOIN LATERAL jsonb_array_elements(upload.sources) AS source(value)
      WHERE upload.shop_id = ${shopId} AND candidate.path IN (
        source.value->>'storagePath', (source.value->>'storagePath') || ${previewSuffix},
        source.value->'preview'->>'storagePath'
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM receipts WHERE shop_id = ${shopId}
        AND candidate.path IN (storage_path, storage_path || ${previewSuffix})
    ) AND NOT EXISTS (
      SELECT 1 FROM recipes WHERE shop_id = ${shopId}
        AND candidate.path IN (storage_path, storage_path || ${previewSuffix})
    )`);
  return rows.map(row => row.path);
}

export async function cancelProcessingOrder(
  tx: OrdersTransaction,
  actor: { shopId: string; userId: string; traceId: string; orderId: string; ipAddress?: string },
  decision: CancellationDecision,
): Promise<'cancelled' | 'deleted'> {
  const { shopId, orderId } = actor;
  const orderScope = and(eq(orders.id, orderId), eq(orders.shopId, shopId), isNull(orders.deletedAt));
  const [order] = await tx.select({ status: orders.status }).from(orders).where(orderScope).for('update');
  if (!order) throw notFound('Order not found');
  if (order.status !== 'processing') throw conflict('Only Processing orders can be canceled.');

  const quantities = new Map(decision.stockItems.map(item => [item.orderItemId, item.quantity]));
  if ((!decision.madeItems && quantities.size > 0) || quantities.size !== decision.stockItems.length) {
    throw badRequest('Finished stock must contain unique order lines and requires that items were made.');
  }
  const stock = [];
  if (quantities.size) {
    const lines = await tx.select({ id: orderItems.id, recipeId: orderItems.recipeId, quantity: orderItems.quantity,
      unitCost: orderItems.unitCost, costComplete: orderItems.costComplete }).from(orderItems)
      .innerJoin(recipes, and(eq(recipes.id, orderItems.recipeId), eq(recipes.shopId, shopId)))
      .where(and(eq(orderItems.shopId, shopId), eq(orderItems.orderId, orderId), inArray(orderItems.id, [...quantities.keys()])));
    if (lines.length !== quantities.size) throw badRequest('Each finished item must belong to this order.');
    for (const line of lines) {
      const quantity = quantities.get(line.id)!;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > Math.floor(Number(line.quantity))) {
        throw badRequest('Finished quantity must be a whole number within the quantity ordered.');
      }
      stock.push({ shopId, recipeId: line.recipeId, sourceOrderItemId: line.id, quantityAdded: quantity,
        quantityRemaining: quantity, unitCost: line.unitCost, costComplete: line.costComplete });
    }
  }

  const [receipt] = await tx.select({ id: orderPayments.id }).from(orderPayments)
    .where(eq(orderPayments.orderId, orderId)).limit(1);
  let outcome: 'cancelled' | 'deleted' = 'cancelled';
  if (!decision.madeItems && !receipt) {
    const uploads = await tx.select({ sources: mediaUploads.sources }).from(mediaUploads)
      .where(and(eq(mediaUploads.shopId, shopId), eq(mediaUploads.orderId, orderId), eq(mediaUploads.kind, 'order')));
    const paths = new Set(uploads.flatMap(upload => upload.sources.flatMap(sourceStoragePaths))
      .filter(path => path.startsWith(`${shopId}/orders/`)));
    await tx.delete(orders).where(orderScope);
    await scheduleObjectDeletions(tx, { shopId, traceId: actor.traceId, paths: await unsharedPaths(tx, shopId, [...paths]) });
    outcome = 'deleted';
  } else {
    await tx.update(orders).set({ status: 'cancelled', cancellationMadeItems: decision.madeItems,
      cancelledAt: sql`now()`, cancelledByUserId: actor.userId }).where(orderScope);
    if (stock.length) await tx.insert(finishedStock).values(stock);
  }
  await recordAudit({ shopId, userId: actor.userId, resourceId: orderId, ipAddress: actor.ipAddress,
    eventType: 'ORDER_CANCELLED', metadata: { from: 'processing', outcome } }, tx);
  return outcome;
}

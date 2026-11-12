import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  mediaUploads,
  orderItems,
  receipts,
  recipeIngredients,
  recipes,
  shopMembers,
  shops,
} from '../../db/schema/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { sourceStoragePaths } from '../../lib/documentPreviews.js';
import { scheduleObjectDeletions } from '../../lib/storageCleanup.js';
import { shopNameMatches } from './contracts.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function storagePaths(tx: Transaction, shopId: string) {
  const recipeRows = await tx
    .select({ storagePath: recipes.storagePath })
    .from(recipes)
    .where(eq(recipes.shopId, shopId));
  const receiptRows = await tx
    .select({ storagePath: receipts.storagePath })
    .from(receipts)
    .where(eq(receipts.shopId, shopId));
  const uploads = await tx
    .select({ sources: mediaUploads.sources })
    .from(mediaUploads)
    .where(eq(mediaUploads.shopId, shopId));
  return [
    ...recipeRows.map((row) => row.storagePath),
    ...receiptRows.map((row) => row.storagePath),
    ...uploads.flatMap((upload) => upload.sources.flatMap(sourceStoragePaths)),
  ];
}

/** Lock the shop, queue its files, then remove shop-owned rows. A thrown error rolls the transaction back. */
export async function deleteOwnedShop(
  database: Database,
  input: { shopId: string; userId: string; name: string; traceId: string },
) {
  await database.transaction(async (tx) => {
    const [shop] = await tx
      .select()
      .from(shops)
      .where(eq(shops.id, input.shopId))
      .limit(1)
      .for('update');
    if (!shop) throw notFound('Shop not found');
    const [membership] = await tx
      .select({ role: shopMembers.role })
      .from(shopMembers)
      .where(and(eq(shopMembers.shopId, shop.id), eq(shopMembers.userId, input.userId)))
      .limit(1);
    if (!membership) throw notFound('Shop not found');
    if (membership.role !== 'owner') {
      throw forbidden('Only the shop owner can delete this shop');
    }
    if (!shopNameMatches(shop.name, input.name)) {
      throw conflict('The shop name does not match.');
    }
    await scheduleObjectDeletions(tx, {
      shopId: shop.id,
      traceId: input.traceId,
      paths: await storagePaths(tx, shop.id),
    });
    // These children restrict each other, so remove them before the shop cascade.
    await tx.delete(orderItems).where(eq(orderItems.shopId, shop.id));
    await tx.delete(recipeIngredients).where(eq(recipeIngredients.shopId, shop.id));
    await tx.delete(shops).where(eq(shops.id, shop.id));
  });
}

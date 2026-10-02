import { Worker, UnrecoverableError, type Job } from 'bullmq';
import pino from 'pino';
import { and, eq, ilike } from 'drizzle-orm';
import { db, sql as sqlClient } from './db/client.js';
import {
  inventoryItems,
  orderItems,
  orders,
  receiptItems,
  receipts,
  recipes,
  recipeIngredients,
  shops,
} from './db/schema/index.js';
import {
  createRedisConnection,
  QUEUE_NAME,
  type MediaJobData,
} from './lib/queue.js';
import { getObjectBytes } from './lib/storage.js';
import { extractOrder, extractReceipt, extractRecipe } from './lib/gemini.js';
import { isPermanentError, publicFailureMessage } from './lib/jobErrors.js';
import { money, quantity as qty, toNumber, unitCost } from './lib/money.js';
import { applyWeightedAverage, calculateRetailPrice, calculateUnitCost } from './lib/pricing.js';
import { env, isProduction } from './env.js';

const logger = pino({
  level: isProduction ? 'info' : 'debug',
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function findOrCreateInventoryItem(
  shopId: string,
  rawName: string,
  unit: string | null,
): Promise<string | null> {
  const name = rawName.trim();
  if (name.length === 0) return null;

  const exact = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), eq(inventoryItems.name, name)))
    .limit(1);
  if (exact[0]) return exact[0].id;

  const fuzzy = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), ilike(inventoryItems.name, `%${name}%`)))
    .limit(1);
  if (fuzzy[0]) return fuzzy[0].id;

  const created = await db
    .insert(inventoryItems)
    .values({
      shopId,
      name,
      unit: (['kg', 'g', 'l', 'ml', 'unit', 'pack'] as const).includes(
        (unit ?? '') as 'kg',
      )
        ? ((unit ?? 'unit') as 'kg' | 'g' | 'l' | 'ml' | 'unit' | 'pack')
        : 'unit',
      currentQuantity: '0.000',
    })
    .returning({ id: inventoryItems.id });

  return created[0]?.id ?? null;
}

/**
 * Applies a purchased line to inventory: bumps stock and rolls the weighted
 * moving average unit cost forward.
 */
async function applyPurchase(
  inventoryItemId: string,
  purchasedQuantity: number,
  unitPrice: number,
): Promise<void> {
  const rows = await db
    .select({
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId))
    .limit(1);

  const current = rows[0];
  if (!current) return;

  const next = applyWeightedAverage(
    { currentQuantity: current.currentQuantity, averageUnitCost: current.averageUnitCost },
    { quantity: purchasedQuantity, unitPrice },
  );

  await db
    .update(inventoryItems)
    .set({
      currentQuantity: qty(next.currentQuantity),
      lastUnitCost: unitCost(next.lastUnitCost),
      averageUnitCost: unitCost(next.averageUnitCost),
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, inventoryItemId));
}

async function processReceipt(data: MediaJobData, job: Job<MediaJobData>) {
  const bytes = await getObjectBytes(data.storagePath);
  const extraction = await extractReceipt({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });

  if (!extraction) {
    throw new Error('Gemini returned no parsable receipt extraction');
  }

  const jobLogger = logger.child({ jobId: job.id, shopId: data.shopId });

  await db.transaction(async (tx) => {
    const receiptRows = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)),
      )
      .limit(1);
    const receiptId = receiptRows[0]?.id;
    if (!receiptId) {
      jobLogger.warn('receipt row missing for storage path');
      return;
    }

    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));

    const itemRows = [];
    for (const item of extraction.items) {
      const inventoryItemId = await findOrCreateInventoryItem(
        data.shopId,
        item.rawName,
        item.unit,
      );

      if (inventoryItemId && item.quantity && item.unitPrice) {
        await applyPurchase(inventoryItemId, item.quantity, item.unitPrice);
      }

      const inserted = await tx
        .insert(receiptItems)
        .values({
          shopId: data.shopId,
          receiptId,
          inventoryItemId,
          rawName: item.rawName,
          quantity: item.quantity === null ? null : qty(item.quantity),
          unitPrice: item.unitPrice === null ? null : unitCost(item.unitPrice),
          totalPrice: item.totalPrice === null ? null : money(item.totalPrice),
          unit: item.unit,
          confidence: item.confidence === null ? null : item.confidence.toFixed(3),
        })
        .returning({ id: receiptItems.id });

      itemRows.push(inserted[0]?.id);
    }

    const derivedTotal =
      extraction.totalAmount ??
      extraction.items.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);

    await tx
      .update(receipts)
      .set({
        merchantName: extraction.merchantName,
        receiptDate: extraction.receiptDate,
        totalAmount: money(derivedTotal),
        taxAmount: extraction.taxAmount === null ? null : money(extraction.taxAmount),
        currency: extraction.currency,
        status: 'completed',
        rawExtraction: extraction as unknown as Record<string, unknown>,
        processedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(receipts.id, receiptId));
  });

  jobLogger.info(
    { items: extraction.items.length, merchant: extraction.merchantName },
    'receipt processed',
  );
}

async function processRecipe(data: MediaJobData, job: Job<MediaJobData>) {
  const bytes = await getObjectBytes(data.storagePath);
  const extraction = await extractRecipe({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });

  if (!extraction?.name) {
    throw new Error('Gemini returned no parsable recipe extraction');
  }

  const {
    name,
    description,
    prepTimeMinutes,
    yieldQuantity,
    yieldUnit,
    allergens,
    instructions,
  } = extraction;
  const safeName = name;

  const shopRows = await db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);
  const shop = shopRows[0];

  const linkedIngredientIds = new Map<string, string>();
  for (const ingredient of extraction.ingredients) {
    const inventoryItemId = await findOrCreateInventoryItem(
      data.shopId,
      ingredient.rawName,
      ingredient.unit,
    );
    if (inventoryItemId) linkedIngredientIds.set(ingredient.rawName, inventoryItemId);
  }

  const costed = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(recipes)
      .values({
        shopId: data.shopId,
        name: safeName,
        description,
        prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
        yieldQuantity: qty(
          yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1,
        ),
        yieldUnit: yieldUnit ?? 'portion',
        allergens,
        instructions,
      })
      .returning();

    const recipe = inserted[0];
    if (!recipe) throw new Error('recipe insert returned no row');

    const bill = extraction.ingredients
      .map((ingredient) => {
        const inventoryItemId = linkedIngredientIds.get(ingredient.rawName);
        if (!inventoryItemId || !ingredient.quantity) return null;
        return {
          shopId: data.shopId,
          recipeId: recipe.id,
          inventoryItemId,
          quantity: qty(ingredient.quantity),
          unit: ingredient.unit ?? 'unit',
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (bill.length > 0) {
      await tx.insert(recipeIngredients).values(bill);
    }

    return recipe;
  });

  logger.info(
    {
      jobId: job.id,
      recipeId: costed.id,
      name: costed.name,
      hourlyLaborCost: shop?.hourlyLaborCost,
    },
    'recipe drafted from document',
  );
}

async function processOrderDocument(data: MediaJobData, job: Job<MediaJobData>) {
  const bytes = await getObjectBytes(data.storagePath);
  const extraction = await extractOrder({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });

  if (!extraction || extraction.items.length === 0) {
    throw new Error('Gemini returned no parsable order extraction');
  }

  if (!data.orderId) {
    logger.warn({ jobId: job.id }, 'order document uploaded without a target order');
    return;
  }

  const orderRows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, data.orderId), eq(orders.shopId, data.shopId)))
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    logger.warn({ jobId: job.id, orderId: data.orderId }, 'target order not found');
    return;
  }

  const recipeRows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.isActive, true)));
  const byName = new Map(recipeRows.map((recipe) => [recipe.name.toLowerCase(), recipe]));

  const shopRows = await db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);
  const shop = shopRows[0];

  const matched = extraction.items
    .map((item) => {
      const recipe = byName.get(item.name.trim().toLowerCase());
      if (!recipe) return null;
      const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1;
      return { recipe, quantity, unitPrice: item.unitPrice };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (matched.length === 0) {
    logger.info({ jobId: job.id }, 'no order lines matched catalog recipes');
    return;
  }

  const ingredientRows = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .innerJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .where(eq(recipeIngredients.shopId, data.shopId));
  const byRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    byRecipe.set(row.recipeId, [...(byRecipe.get(row.recipeId) ?? []), row]);
  }

  const priced = matched.map((row) => {
    const breakdown = calculateUnitCost({
      ingredients: (byRecipe.get(row.recipe.id) ?? []).map((i) => ({
        quantity: i.quantity,
        averageUnitCost: i.averageUnitCost,
      })),
      prepTimeMinutes: row.recipe.prepTimeMinutes,
      hourlyLaborCost: shop?.hourlyLaborCost ?? '0',
      yieldQuantity: row.recipe.yieldQuantity,
    });
    const { retailPrice } = calculateRetailPrice(
      breakdown.unitCost,
      shop?.targetProfitMargin ?? '0',
      row.recipe.targetMarginPct,
    );
    return {
      recipeId: row.recipe.id,
      quantity: row.quantity,
      unitCost: breakdown.unitCost,
      unitPrice: row.unitPrice ?? retailPrice,
    };
  });

  await db.transaction(async (tx) => {
    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    await tx.insert(orderItems).values(
      priced.map((row) => ({
        shopId: data.shopId,
        orderId: order.id,
        recipeId: row.recipeId,
        quantity: qty(row.quantity),
        unitCost: money(row.unitCost),
        unitPrice: money(row.unitPrice),
      })),
    );

    const totalCost = priced.reduce((sum, row) => sum + row.quantity * row.unitCost, 0);
    const subtotal = priced.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);

    await tx
      .update(orders)
      .set({
        ...(extraction.customerName && !order.customerName
          ? { customerName: extraction.customerName }
          : {}),
        ...(extraction.destinationAddress && !order.destinationAddress
          ? { destinationAddress: extraction.destinationAddress }
          : {}),
        totalCost: money(totalCost),
        totalAmount: money(subtotal + toNumber(order.deliveryFee)),
      })
      .where(eq(orders.id, order.id));
  });

  logger.info({ jobId: job.id, orderId: order.id, lines: priced.length }, 'order auto-filled');
}

/**
 * Records the terminal failure on the receipt row. Without this the UI polls
 * `/receipts/:id/status` forever on "processing" and never offers reprocess.
 * Only fires once BullMQ has exhausted attempts, so transient failures stay
 * invisible to the shop.
 */
async function recordTerminalFailure(
  data: MediaJobData,
  error: unknown,
): Promise<void> {
  if (data.kind !== 'receipt') return;

  const message = publicFailureMessage(error);
  try {
    await db
      .update(receipts)
      .set({
        status: 'failed',
        errorMessage: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, data.storagePath)));
  } catch (updateError) {
    logger.error(
      { err: updateError, jobShopId: data.shopId },
      'could not record terminal receipt failure',
    );
  }
}

const worker = new Worker<MediaJobData>(
  QUEUE_NAME,
  async (job) => {
    const data = job.data;
    logger.info({ jobId: job.id, kind: data.kind, shopId: data.shopId }, 'job started');

    try {
      switch (data.kind) {
        case 'receipt':
          await processReceipt(data, job);
          break;
        case 'recipe':
        case 'product':
          await processRecipe(data, job);
          break;
        case 'order':
          await processOrderDocument(data, job);
          break;
        default:
          throw new Error(`Unsupported job kind: ${String(data.kind)}`);
      }
    } catch (error) {
      // Billing/auth/malformed-payload errors will not resolve on retry, so
      // drop them straight to failed instead of spending the backoff schedule.
      if (isPermanentError(error)) {
        await recordTerminalFailure(data, error);
        throw new UnrecoverableError(publicFailureMessage(error));
      }
      throw error;
    }

    logger.info({ jobId: job.id, kind: data.kind }, 'job completed');
  },
  {
    connection: createRedisConnection(),
    concurrency: env.RECEIPT_WORKER_CONCURRENCY,
  },
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job done'));
worker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, err: error }, 'job failed');
  // Covers transient errors that ran out of attempts, so the receipt row does
  // not stay on "processing" with no explanation.
  if (job && error instanceof UnrecoverableError) return;
  if (!job) return;
  void recordTerminalFailure(job.data, error);
});
worker.on('error', (error) => logger.error({ err: error }, 'worker error'));

logger.info(
  { queue: QUEUE_NAME, concurrency: env.RECEIPT_WORKER_CONCURRENCY },
  'neuton vision worker ready',
);

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, closing worker`);
  await worker.close();
  await sqlClient.end({ timeout: 5 }).catch(() => { });
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

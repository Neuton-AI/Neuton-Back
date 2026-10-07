import { pathToFileURL } from 'node:url';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import pino from 'pino';
import { and, eq, isNull } from 'drizzle-orm';
import { db, sql as sqlClient, type Database } from './db/client.js';
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
import { calculateRetailPrice, calculateUnitCost } from './lib/pricing.js';
import {
  findOrCreateInventoryItem as findOrCreateInventoryItemOn,
  type InventoryDb,
} from './lib/inventory.js';
import { env, isDevelopment } from './env.js';
import { geminiCircuitBreaker, CircuitOpenError } from './lib/circuitBreaker.js';
import { RECEIPT_PROGRESS_STAGES, type ReceiptProgressStage } from './db/schema/receipts.js';

const logger = pino({
  // A test run should assert on output, not emit a wall of JSON between cases.
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  // pino-pretty ships logs through a worker thread, so it is limited to
  // development. Anywhere else (tests, CI) plain JSON is used, which keeps the
  // process able to exit.
  ...(isDevelopment ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});

/**
 * Collaborators each job handler reaches for. Injected so the handlers can be
 * exercised without a live Postgres, an R2 bucket or a Gemini key; production
 * always passes `defaultWorkerDeps`.
 */
export interface WorkerDeps {
  db: Database;
  getObjectBytes: (key: string) => Promise<Uint8Array>;
  extractReceipt: typeof extractReceipt;
  extractRecipe: typeof extractRecipe;
  extractOrder: typeof extractOrder;
}

export const defaultWorkerDeps: WorkerDeps = {
  db,
  getObjectBytes,
  extractReceipt,
  extractRecipe,
  extractOrder,
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Thin `WorkerDeps` wrapper over the shared inventory helper, kept so
 * `scripts/worker.test.ts` can still exercise it through the worker's own
 * signature. The handlers below deliberately do **not** use it: they take a
 * transaction handle instead, so inventory writes commit or roll back with the
 * receipt they belong to.
 */
export async function findOrCreateInventoryItem(
  deps: WorkerDeps,
  shopId: string,
  rawName: string,
  unit: string | null,
): Promise<string | null> {
  return findOrCreateInventoryItemOn(deps.db, shopId, rawName, unit);
}

async function updateReceiptProgress(
  deps: WorkerDeps,
  shopId: string,
  storagePath: string,
  stage: ReceiptProgressStage,
  message: string,
): Promise<void> {
  await deps.db
    .update(receipts)
    .set({
      progressStage: stage,
      progressMessage: message,
      updatedAt: new Date(),
    })
    .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, storagePath)));
}

function checkDeadline(deadline: Date | null): void {
  if (deadline && new Date() > deadline) {
    throw new Error('Processing deadline exceeded');
  }
}

export async function processReceipt(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process receipt without storagePath');
  }

  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + env.RECEIPT_PROCESSING_TIMEOUT_MS);

  // Initialize processing tracking
  await deps.db
    .update(receipts)
    .set({
      status: 'processing',
      progressStage: 'extracting',
      progressMessage: 'Downloading document from storage',
      processingStartedAt: startedAt,
      processingDeadline: deadline,
      updatedAt: new Date(),
    })
    .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, storagePath)));

  const bytes = await deps.getObjectBytes(storagePath);
  checkDeadline(deadline);

  await updateReceiptProgress(deps, data.shopId, storagePath, 'extracting', 'Extracting receipt data with AI');
  await job.updateProgress(10);

  const extraction = await deps.extractReceipt({
    mimeType: data.contentType,
    data: toBase64(bytes),
  });
  checkDeadline(deadline);

  if (!extraction) {
    throw new Error('Gemini returned no parsable receipt extraction');
  }

  await updateReceiptProgress(deps, data.shopId, storagePath, 'validating', 'Validating extracted data');
  await job.updateProgress(30);

  const jobLogger = logger.child({ jobId: job.id, shopId: data.shopId });

  await deps.db.transaction(async (tx) => {
    const receiptRows = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, storagePath)),
      )
      .limit(1);
    const receiptId = receiptRows[0]?.id;
    if (!receiptId) {
      jobLogger.warn('receipt row missing for storage path');
      return;
    }

    checkDeadline(deadline);
    await updateReceiptProgress(deps, data.shopId, storagePath, 'validating', 'Clearing previous line items');
    await tx.delete(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    await job.updateProgress(40);

    for (let i = 0; i < extraction.items.length; i++) {
      checkDeadline(deadline);
      const item = extraction.items[i]!;
      const progress = 40 + Math.floor((i / extraction.items.length) * 40);
      await updateReceiptProgress(
        deps,
        data.shopId,
        storagePath,
        'validating',
        `Saving line item ${i + 1} of ${extraction.items.length}`,
      );
      await job.updateProgress(progress);

      // No inventory resolution, on purpose: the worker only extracts. Leaving
      // `inventoryItemId` null is the durable signal that nobody has approved
      // this line yet, and it is what `POST /receipts/:id/verify` reads to tell
      // an untouched receipt from one that has already been applied. Doing it
      // here is also what stops a wrong AI reading from corrupting stock counts
      // before a human has seen the numbers.
      await tx.insert(receiptItems).values({
        shopId: data.shopId,
        receiptId,
        inventoryItemId: null,
        rawName: item.rawName,
        quantity: item.quantity === null ? null : qty(item.quantity),
        unitPrice: item.unitPrice === null ? null : unitCost(item.unitPrice),
        totalPrice: item.totalPrice === null ? null : money(item.totalPrice),
        unit: item.unit,
        confidence: item.confidence === null ? null : item.confidence.toFixed(3),
      });
    }

    checkDeadline(deadline);
    await updateReceiptProgress(deps, data.shopId, storagePath, 'validating', 'Saving receipt');
    await job.updateProgress(85);

    const derivedTotal =
      extraction.totalAmount ??
      extraction.items.reduce((sum, item) => sum + (item.totalPrice ?? 0), 0);

    // `status` and `progressStage` deliberately part ways here: the worker is
    // finished (progress stage `completed`) but the receipt is only extracted,
    // not accepted (`status` `unverified`). `verified_at` carries apply time
    // now, so `processedAt` below means "extraction finished" and nothing more.
    await tx
      .update(receipts)
      .set({
        merchantName: extraction.merchantName,
        receiptDate: extraction.receiptDate,
        totalAmount: money(derivedTotal),
        taxAmount: extraction.taxAmount === null ? null : money(extraction.taxAmount),
        currency: extraction.currency,
        status: 'unverified',
        progressStage: 'completed',
        progressMessage: 'Ready for verification',
        rawExtraction: extraction as unknown as Record<string, unknown>,
        processedAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(receipts.id, receiptId));
    await job.updateProgress(100);
  });

  jobLogger.info(
    { items: extraction.items.length, merchant: extraction.merchantName },
    'receipt extracted, awaiting verification',
  );
}

export async function processRecipe(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process recipe without storagePath');
  }

  // Claim the row by (shopId, storagePath) and set to 'processing'
  const claimRows = await deps.db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.storagePath, storagePath)))
    .limit(1);
  const existingRecipe = claimRows[0];

  if (existingRecipe) {
    await deps.db
      .update(recipes)
      .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
      .where(eq(recipes.id, existingRecipe.id));
  }

  const bytes = await deps.getObjectBytes(storagePath);
  const extraction = await deps.extractRecipe({
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

  const shopRows = await deps.db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, data.shopId))
    .limit(1);
  const shop = shopRows[0];

  // Resolution must run on the same handle the rest of the write runs on: a job
  // that fails its transaction rolls the recipe back, and any SKU created
  // outside it would survive as a zero-cost orphan (N-28's rule — writes go
  // through `tx`, never the shared client).
  const resolveLinkedIngredientIds = async (handle: InventoryDb): Promise<Map<string, string>> => {
    const linked = new Map<string, string>();
    for (const ingredient of extraction.ingredients) {
      const found = await findOrCreateInventoryItemOn(
        handle,
        data.shopId,
        ingredient.rawName,
        ingredient.unit,
        'recipe',
      );
      if (found) linked.set(ingredient.rawName, found);
    }
    return linked;
  };

  if (existingRecipe) {
    // Update existing row: replace extracted fields + ingredients + set unverified
    await deps.db.transaction(async (tx) => {
      const linkedIngredientIds = await resolveLinkedIngredientIds(tx);
      await tx
        .update(recipes)
        .set({
          name: safeName,
          description,
          prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
          yieldQuantity: qty(yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1),
          yieldUnit: yieldUnit ?? 'portion',
          allergens,
          instructions,
          status: 'unverified',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(recipes.id, existingRecipe.id));

      // Replace ingredients
      await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, existingRecipe.id));

      const bill = extraction.ingredients.map((ingredient) => {
        const inventoryItemId = linkedIngredientIds.get(ingredient.rawName) ?? null;
        return {
          shopId: data.shopId,
          recipeId: existingRecipe.id,
          inventoryItemId,
          rawName: ingredient.rawName,
          quantity: qty(ingredient.quantity && ingredient.quantity > 0 ? ingredient.quantity : 1),
          unit: ingredient.unit ?? 'unit',
        };
      });

      await tx.insert(recipeIngredients).values(bill);
    });

    logger.info(
      {
        jobId: job.id,
        recipeId: existingRecipe.id,
        name: safeName,
        hourlyLaborCost: shop?.hourlyLaborCost,
      },
      'recipe extracted and set to unverified',
    );
  } else {
    // Legacy fallback: no row exists, insert directly as 'unverified' with storagePath
    const inserted = await deps.db.transaction(async (tx) => {
      const linkedIngredientIds = await resolveLinkedIngredientIds(tx);
      const newRecipe = await tx
        .insert(recipes)
        .values({
          shopId: data.shopId,
          name: safeName,
          description,
          prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
          yieldQuantity: qty(yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1),
          yieldUnit: yieldUnit ?? 'portion',
          allergens,
          instructions,
          storagePath,
          status: 'unverified',
        })
        .returning();

      const recipe = newRecipe[0];
      if (!recipe) throw new Error('recipe insert returned no row');

      const bill = extraction.ingredients.map((ingredient) => {
        const inventoryItemId = linkedIngredientIds.get(ingredient.rawName) ?? null;
        return {
          shopId: data.shopId,
          recipeId: recipe.id,
          inventoryItemId,
          rawName: ingredient.rawName,
          quantity: qty(ingredient.quantity && ingredient.quantity > 0 ? ingredient.quantity : 1),
          unit: ingredient.unit ?? 'unit',
        };
      });

      await tx.insert(recipeIngredients).values(bill);

      return recipe;
    });

    logger.info(
      {
        jobId: job.id,
        recipeId: inserted.id,
        name: inserted.name,
        hourlyLaborCost: shop?.hourlyLaborCost,
      },
      'recipe drafted from document (legacy fallback)',
    );
  }
}

export async function processOrderDocument(
  deps: WorkerDeps,
  data: MediaJobData,
  job: Job<MediaJobData>,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process order document without storagePath');
  }
  const bytes = await deps.getObjectBytes(storagePath);
  const extraction = await deps.extractOrder({
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

  const orderRows = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, data.orderId), eq(orders.shopId, data.shopId), isNull(orders.deletedAt)))
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    logger.warn({ jobId: job.id, orderId: data.orderId }, 'target order not found');
    return;
  }

  const recipeRows = await deps.db
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.isActive, true)));
  const byName = new Map(recipeRows.map((recipe) => [recipe.name.toLowerCase(), recipe]));

  const shopRows = await deps.db
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

  const ingredientRows = await deps.db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.quantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .leftJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .where(eq(recipeIngredients.shopId, data.shopId));
  const byRecipe = new Map<string, typeof ingredientRows>();
  for (const row of ingredientRows) {
    byRecipe.set(row.recipeId, [...(byRecipe.get(row.recipeId) ?? []), row]);
  }

  const priced = matched.map((row) => {
    const breakdown = calculateUnitCost({
      ingredients: (byRecipe.get(row.recipe.id) ?? []).map((i) => ({
        quantity: i.quantity,
        averageUnitCost: i.averageUnitCost ?? '0',
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

  await deps.db.transaction(async (tx) => {
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
 * Records the terminal failure on the receipt/recipe row. Without this the UI polls
 * `/receipts/:id/status` or `/recipes/:id` forever on "processing" with no error to show.
 * Only fires once BullMQ has exhausted attempts, so transient failures stay
 * invisible to the shop.
 */
export async function recordTerminalFailure(
  deps: WorkerDeps,
  data: MediaJobData,
  error: unknown,
): Promise<void> {
  const storagePath = data.storagePath;
  if (!storagePath) return;

  const message = publicFailureMessage(error);
  const isTimeout = error instanceof Error && error.message.includes('deadline exceeded');
  try {
    if (data.kind === 'receipt') {
      await deps.db
        .update(receipts)
        .set({
          status: 'failed',
          progressStage: isTimeout ? 'failed' : undefined,
          progressMessage: isTimeout ? 'Processing timed out' : undefined,
          errorMessage: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, storagePath)));
    } else if (data.kind === 'recipe' || data.kind === 'product') {
      await deps.db
        .update(recipes)
        .set({
          status: 'failed',
          errorMessage: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(and(eq(recipes.shopId, data.shopId), eq(recipes.storagePath, storagePath)));
    }
  } catch (updateError) {
    logger.error(
      { err: updateError, jobShopId: data.shopId, kind: data.kind },
      'could not record terminal failure',
    );
  }
}

/**
 * Routes a job to its handler and translates failures into BullMQ semantics.
 * Permanent errors stop the retry schedule and surface a shop-safe message.
 * Also enforces an overall processing deadline and respects the circuit breaker.
 */
export async function runJob(
  data: MediaJobData,
  job: Job<MediaJobData>,
  deps: WorkerDeps = defaultWorkerDeps,
): Promise<void> {
  const jobLogger = logger.child({ jobId: job.id, kind: data.kind, shopId: data.shopId });
  jobLogger.info('job started');

  // Check circuit breaker before starting
  if (!geminiCircuitBreaker.canExecute()) {
    const status = geminiCircuitBreaker.getStatus();
    jobLogger.warn({ circuitState: status.state, failureCount: status.failureCount }, 'circuit breaker open, failing fast');
    throw new CircuitOpenError(env.CIRCUIT_BREAKER_RESET_MS);
  }

  // Overall deadline for the entire job (including retries within the job)
  const deadline = Date.now() + env.RECEIPT_PROCESSING_TIMEOUT_MS;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(`Job exceeded overall processing deadline of ${env.RECEIPT_PROCESSING_TIMEOUT_MS}ms`);
    }
  };

  try {
    checkDeadline();
    switch (data.kind) {
      case 'receipt':
        await processReceipt(deps, data, job);
        break;
      case 'recipe':
      case 'product':
        await processRecipe(deps, data, job);
        break;
      case 'order':
        await processOrderDocument(deps, data, job);
        break;
      default:
        throw new Error(`Unsupported job kind: ${String(data.kind)}`);
    }
    // Record success for circuit breaker
    geminiCircuitBreaker.recordSuccess();
  } catch (error) {
    // Record failure for circuit breaker (but not for permanent errors or circuit open)
    if (!(error instanceof CircuitOpenError) && !isPermanentError(error)) {
      geminiCircuitBreaker.recordFailure();
    }

    // Billing/auth/malformed-payload errors will not resolve on retry, so
    // drop them straight to failed instead of spending the backoff schedule.
    if (isPermanentError(error)) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }

    // Processing deadline exceeded - treat as permanent failure to avoid retries
    if (error instanceof Error && error.message.includes('deadline exceeded')) {
      await recordTerminalFailure(deps, data, error);
      throw new UnrecoverableError(publicFailureMessage(error));
    }
    throw error;
  }

  jobLogger.info('job completed');
}

/**
 * Importing this module must not boot a worker: the test suite imports it to
 * exercise the handlers above, and a stray worker would hold a Redis
 * connection and the event loop open.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

function startWorker(): void {
  const worker = new Worker<MediaJobData>(QUEUE_NAME, (job) => runJob(job.data, job), {
    connection: createRedisConnection(),
    concurrency: env.RECEIPT_WORKER_CONCURRENCY,
    /** Duration of the lock for the job in milliseconds. If the lock is lost, the job will be moved back to wait. */
    lockDuration: env.JOB_LOCK_DURATION_MS,
  });

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job done'));
  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, err: error }, 'job failed');
    // Covers transient errors that ran out of attempts, so the receipt row does
    // not stay on "processing" with no explanation.
    if (job && (error instanceof UnrecoverableError || error instanceof CircuitOpenError)) return;
    if (!job) return;
    void recordTerminalFailure(defaultWorkerDeps, job.data, error);
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
}

if (isEntrypoint()) {
  startWorker();
}

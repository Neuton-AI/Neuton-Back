import { pathToFileURL } from 'node:url';
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, sql as sqlClient, type Database } from './db/client.js';
import {
  inventoryItems,
  generalPrices,
  orderItems,
  orders,
  receiptItems,
  receipts,
  recipes,
  recipeIngredients,
  shops,
  mediaUploads,
} from './db/schema/index.js';
import {
  createRedisConnection,
  QUEUE_NAME,
  type MediaJobData,
} from './lib/queue.js';
import { getObjectBytes } from './lib/storage.js';
import { extractOrder, extractReceipt, extractRecipe } from './lib/gemini.js';
import { convertRecipeToBaseUnits } from './lib/recipeConversion.js';
import { isPermanentError, publicFailureMessage } from './lib/jobErrors.js';
import { isHtmlSafe } from './lib/safeText.js';
import { money, quantity as qty, toNumber, unitCost } from './lib/money.js';
import { calculateRetailPrice, calculateUnitCost } from './lib/pricing.js';
import {
  findOrCreateInventoryItem as findOrCreateInventoryItemOn,
} from './lib/inventory.js';
import { env } from './env.js';
import { loggerFactory, workerLogger } from './lib/logger/index.js';
import { geminiCircuitBreaker, CircuitOpenError } from './lib/circuitBreaker.js';
import { prepareRecipeFallbackPrices, persistRecipeFallbackPrices } from './lib/recipePriceFallback.js';
import { resolveRecipeInventoryLinks } from './lib/recipeInventory.js';
import { resolveUniqueRecipeName } from './lib/recipeName.js';
import { enrichReciptItems, searchProduct } from './lib/supermarket/prices.js';
import { recipeIngredientUnitCost } from './lib/recipeCostQuery.js';
import { RECEIPT_PROGRESS_STAGES, type ReceiptProgressStage } from './db/schema/receipts.js';
import { setSrcUnitAmount, setUnitsData } from './lib/supermarket/conversion.js';
import { validateSourceLimits } from './lib/mediaUploads.js';
import type { DocumentInput } from './lib/gemini.js';

/**
 * Correlation context shared by a job's logger and its Gemini extraction
 * calls (issue #99): same jobId/traceId/shopId/userId on the worker lines and
 * on the `gemini` service lines, so one traceId query spans both services.
 */
function jobLogContext(data: MediaJobData, job: Job<MediaJobData>) {
  return {
    jobId: job.id,
    kind: data.kind,
    shopId: data.shopId,
    userId: data.uploadedBy ?? undefined,
    traceId: data.traceId,
  };
}

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
  searchProduct: typeof searchProduct;
}

export const defaultWorkerDeps: WorkerDeps = {
  db,
  getObjectBytes,
  extractReceipt,
  extractRecipe,
  extractOrder,
  searchProduct,
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Download all parts before extraction; a missing later part never yields a partial document. */
export async function loadDocumentInput(deps: WorkerDeps, data: MediaJobData): Promise<DocumentInput> {
  const sources = data.sources ?? [{ storagePath: data.storagePath, contentType: data.contentType }];
  const documents = [];
  for (const source of sources) {
    if (!source.storagePath || !source.storagePath.startsWith(`${data.shopId}/`)) throw new Error('Invalid document source');
    const bytes = await deps.getObjectBytes(source.storagePath);
    if ('byteSize' in source && bytes.byteLength !== source.byteSize) throw new Error('Document source size changed after submission');
    documents.push({ mimeType: source.contentType, data: toBase64(bytes) });
  }
  if (!documents[0]) throw new Error('Document has no sources');
  return { ...documents[0], ...(data.sources ? { sources: documents } : {}) };
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

  const jobLogger = workerLogger.child(jobLogContext(data, job));
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

  const document = await loadDocumentInput(deps, data);
  checkDeadline(deadline);

  await updateReceiptProgress(deps, data.shopId, storagePath, 'extracting', 'Extracting receipt data with AI');
  await job.updateProgress(10);

  const extraction = await deps.extractReceipt(
    document,
    jobLogContext(data, job),
  );
  checkDeadline(deadline);

  if (!extraction) {
    throw new Error('Gemini returned no parsable receipt extraction');
  }

  const receiptItemsWithEnrichment = await enrichReciptItems(extraction, deps.searchProduct)
  const itemsWithUnitsAmounts = setUnitsData(receiptItemsWithEnrichment)

  await updateReceiptProgress(deps, data.shopId, storagePath, 'validating', 'Validating extracted data');
  await job.updateProgress(30);

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

    for (let i = 0; i < itemsWithUnitsAmounts.length; i++) {
      checkDeadline(deadline);
      const { item, itemEnrichment } = itemsWithUnitsAmounts[i]!;
      const progress = 40 + Math.floor((i / itemsWithUnitsAmounts.length) * 40);
      await updateReceiptProgress(
        deps,
        data.shopId,
        storagePath,
        'validating',
        `Saving line item ${i + 1} of ${itemsWithUnitsAmounts.length}`,
      );
      await job.updateProgress(progress);

      let { quantity, unitPrice, totalPrice } = item;
      if (totalPrice === null && quantity !== null && unitPrice !== null) {
        totalPrice = quantity * unitPrice;
      } else if (unitPrice === null && quantity !== null && quantity !== 0 && totalPrice !== null) {
        unitPrice = totalPrice / quantity;
      }
      await tx.insert(receiptItems).values({
        shopId: data.shopId,
        receiptId,
        inventoryItemId: null,
        rawName: item.rawName,
        rawMaterialName: item.rawMaterialName,
        quantity: quantity === null ? null : qty(quantity),
        unitPrice: unitPrice === null ? null : unitCost(unitPrice),
        totalPrice: totalPrice === null ? null : money(totalPrice),
        rawSrcUnit: item.rawSrcUnit,
        srcUnit: item.srcUnit,
        srcUnitAmount: item.srcUnitAmount === null ? null : qty(item.srcUnitAmount),
        baseUnit: item.baseUnit,
        baseUnitAmount: item.baseUnitAmount === null ? null : qty(item.baseUnitAmount),
        rawSku: item.rawSku,
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
  const jobLogger = workerLogger.child(jobLogContext(data, job));

  // Claim the row by (shopId, storagePath) and set to 'processing'
  const claimRows = await deps.db
    .select({ id: recipes.id, status: recipes.status })
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.storagePath, storagePath)))
    .limit(1);
  const existingRecipe = claimRows[0];

  // A completed extraction may be redelivered by the queue. Preserve its links
  // (and any subsequent manual verification) instead of extracting it again.
  if (existingRecipe?.status === 'unverified' || existingRecipe?.status === 'verified') return;

  if (existingRecipe) {
    await deps.db
      .update(recipes)
      .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
      .where(eq(recipes.id, existingRecipe.id));
  }

  const document = await loadDocumentInput(deps, data);
  const extraction = await deps.extractRecipe(
    document,
    jobLogContext(data, job),
  );

  if (!extraction?.name) {
    throw new Error('Gemini returned no parsable recipe extraction');
  }

  const convertedRecipe = convertRecipeToBaseUnits(extraction);

  const {
    name,
    description,
    prepTimeMinutes,
    yieldQuantity,
    yieldUnit,
    allergens,
    steps,
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

  const linkedIngredientIds = await resolveRecipeInventoryLinks(deps.db, data.shopId, convertedRecipe.ingredients);
  const fallbackPrices = await prepareRecipeFallbackPrices(
    convertedRecipe.ingredients.map((ingredient, index) => ({
      ...ingredient, inventoryItemId: linkedIngredientIds[index] ?? null,
    })),
    deps.searchProduct,
  );

  if (existingRecipe) {
    // Update existing row: replace extracted fields + ingredients + set unverified
    await deps.db.transaction(async (tx) => {
      // Re-extraction may yield a name another recipe already holds, so suffix
      // the duplicate ("Recipe Name (2)") instead of violating the (shopId, name) index.
      const uniqueName = await resolveUniqueRecipeName(
        tx,
        data.shopId,
        safeName,
        existingRecipe.id,
      );
      await tx
        .update(recipes)
        .set({
          name: uniqueName,
          description,
          prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
          yieldQuantity: qty(yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1),
          yieldUnit: yieldUnit ?? 'portion',
          allergens,
          steps,
          status: 'unverified',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(recipes.id, existingRecipe.id));

      // Replace ingredients
      await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, existingRecipe.id));

      const bill = convertedRecipe.ingredients.map((ingredient, index) => {
        const inventoryItemId = linkedIngredientIds[index] ?? null;
        return {
          shopId: data.shopId,
          recipeId: existingRecipe.id,
          inventoryItemId,
          rawName: ingredient.rawName,
          rawMaterialName: ingredient.rawMaterialName,
          quantity: qty(ingredient.quantity && ingredient.quantity > 0 ? ingredient.quantity : 1),
          rawSrcUnit: ingredient.rawSrcUnit ?? 'unit',
          baseUnit: ingredient.baseUnit,
          baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
        };
      });

      await tx.insert(recipeIngredients).values(bill);
      await persistRecipeFallbackPrices(tx, data.shopId, existingRecipe.id, fallbackPrices);
    });

    jobLogger.info(
      {
        recipeId: existingRecipe.id,
        name: safeName,
        hourlyLaborCost: shop?.hourlyLaborCost,
      },
      'recipe extracted and set to unverified',
    );
  } else {
    // Legacy fallback: no row exists, insert directly as 'unverified' with storagePath
    const inserted = await deps.db.transaction(async (tx) => {
      // The (shopId, name) unique index rejects a name already in the shop, so
      // suffix the duplicate ("Recipe Name (2)") instead of failing the job.
      const uniqueName = await resolveUniqueRecipeName(tx, data.shopId, safeName);
      const newRecipe = await tx
        .insert(recipes)
        .values({
          shopId: data.shopId,
          name: uniqueName,
          description,
          prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
          yieldQuantity: qty(yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1),
          yieldUnit: yieldUnit ?? 'portion',
          allergens,
          steps,
          storagePath,
          status: 'unverified',
        })
        .returning();

      const recipe = newRecipe[0];
      if (!recipe) throw new Error('recipe insert returned no row');

      const bill = convertedRecipe.ingredients.map((ingredient, index) => {
        const inventoryItemId = linkedIngredientIds[index] ?? null;
        return {
          shopId: data.shopId,
          recipeId: recipe.id,
          inventoryItemId,
          rawName: ingredient.rawName,
          rawMaterialName: ingredient.rawMaterialName?.trim() || ingredient.rawName,
          quantity: qty(ingredient.quantity && ingredient.quantity > 0 ? ingredient.quantity : 1),
          rawSrcUnit: ingredient.rawSrcUnit ?? 'unit',
          baseUnit: ingredient.baseUnit,
          baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
        };
      });

      await tx.insert(recipeIngredients).values(bill);
      await persistRecipeFallbackPrices(tx, data.shopId, recipe.id, fallbackPrices);

      return recipe;
    });

    jobLogger.info(
      {
        recipeId: inserted.id,
        name: inserted.name,
        requestedName: safeName,
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
  const jobLogger = workerLogger.child(jobLogContext(data, job));
  const document = await loadDocumentInput(deps, data);
  const extraction = await deps.extractOrder(
    document,
    jobLogContext(data, job),
  );

  if (!extraction || extraction.items.length === 0) {
    throw new Error('Gemini returned no parsable order extraction');
  }

  if (!data.orderId) {
    jobLogger.warn('order document uploaded without a target order');
    return;
  }

  const orderRows = await deps.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, data.orderId), eq(orders.shopId, data.shopId), isNull(orders.deletedAt)))
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    jobLogger.warn({ orderId: data.orderId }, 'target order not found');
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
    jobLogger.info('no order lines matched catalog recipes');
    return;
  }

  const ingredientRows = await deps.db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.baseUnitAmount,
      averageUnitCost: recipeIngredientUnitCost,
    })
    .from(recipeIngredients)
    .leftJoin(inventoryItems, eq(inventoryItems.id, recipeIngredients.inventoryItemId))
    .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
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
    if (!breakdown.costComplete) throw new Error(`Recipe ${row.recipe.name} has incomplete ingredient costs`);
    const { retailPrice } = calculateRetailPrice(
      breakdown.unitCost,
      shop?.targetProfitMargin ?? '0',
      row.recipe.targetMarginPct,
    );
    return {
      recipeId: row.recipe.id,
      // Snapshotted with the line: order history must survive renames (N-107).
      name: row.recipe.name,
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
        recipeName: row.name,
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
        // Extraction text is written only while it carries no HTML (issue
        // #116): an image can feed the model markup, and the field it would
        // land in is rendered to every shop member. Unsafe values leave the
        // order exactly as it was.
        ...(extraction.customerName && !order.customerName && isHtmlSafe(extraction.customerName)
          ? { customerName: extraction.customerName }
          : {}),
        ...(extraction.destinationAddress &&
          !order.destinationAddress &&
          isHtmlSafe(extraction.destinationAddress)
          ? { destinationAddress: extraction.destinationAddress }
          : {}),
        totalCost: money(totalCost),
        totalAmount: money(subtotal + toNumber(order.deliveryFee)),
      })
      .where(eq(orders.id, order.id));
  });

  jobLogger.info({ orderId: order.id, lines: priced.length }, 'order auto-filled');
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
    if (data.uploadId) {
      const [upload] = await deps.db.select({ processedAt: mediaUploads.processedAt }).from(mediaUploads)
        .where(and(eq(mediaUploads.id, data.uploadId), eq(mediaUploads.shopId, data.shopId))).limit(1);
      if (!upload || upload.processedAt) return;
    }
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
        .where(and(eq(receipts.shopId, data.shopId), eq(receipts.storagePath, storagePath),
          inArray(receipts.status, ['pending', 'processing', 'failed'])));
    } else if (data.kind === 'recipe' || data.kind === 'product') {
      await deps.db
        .update(recipes)
        .set({
          status: 'failed',
          errorMessage: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(and(eq(recipes.shopId, data.shopId), eq(recipes.storagePath, storagePath),
          inArray(recipes.status, ['pending', 'processing', 'failed'])));
    }
  } catch (updateError) {
    workerLogger
      .child({ kind: data.kind, shopId: data.shopId, userId: data.uploadedBy ?? undefined, traceId: data.traceId })
      .error({ err: updateError }, 'could not record terminal failure');
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
  const jobLogger = workerLogger.child(jobLogContext(data, job));
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
    const process = async (currentDeps: WorkerDeps, currentData: MediaJobData) => {
      switch (currentData.kind) {
      case 'receipt':
        await processReceipt(currentDeps, currentData, job);
        break;
      case 'recipe':
      case 'product':
        await processRecipe(currentDeps, currentData, job);
        break;
      case 'order':
        await processOrderDocument(currentDeps, currentData, job);
        break;
      default:
        throw new Error(`Unsupported job kind: ${String(currentData.kind)}`);
      }
    };
    if (data.uploadId) {
      // This durable lock also covers a stalled BullMQ job delivered to two workers.
      // Business writes and processedAt commit together, so a crash cannot replay effects.
      await deps.db.transaction(async (tx) => {
        const [upload] = await tx.select().from(mediaUploads)
          .where(and(eq(mediaUploads.id, data.uploadId!), eq(mediaUploads.shopId, data.shopId))).limit(1).for('update');
        if (!upload || upload.processedAt) return;
        if (!upload.queuedAt) throw new Error('Document has not completed uploading');
        validateSourceLimits(upload.sources);
        const first = upload.sources[0]!;
        await process({ ...deps, db: tx as unknown as Database }, {
          ...data, kind: upload.kind, sources: upload.sources,
          storagePath: first.storagePath, contentType: first.contentType,
          originalFilename: first.originalFilename,
          orderId: upload.orderId ?? undefined,
        });
        await tx.update(mediaUploads).set({ processedAt: new Date() }).where(eq(mediaUploads.id, upload.id));
      });
    } else {
      await process(deps, data);
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

  worker.on('completed', (job) =>
    workerLogger.info(
      { jobId: job.id, traceId: job.data.traceId, shopId: job.data.shopId },
      'job done',
    ),
  );
  worker.on('failed', (job, error) => {
    workerLogger.error(
      {
        jobId: job?.id,
        err: error,
        traceId: job?.data.traceId,
        shopId: job?.data.shopId,
      },
      'job failed',
    );
    // Covers transient errors that ran out of attempts, so the receipt row does
    // not stay on "processing" with no explanation.
    if (job && (error instanceof UnrecoverableError || error instanceof CircuitOpenError)) return;
    if (!job) return;
    void recordTerminalFailure(defaultWorkerDeps, job.data, error);
  });
  worker.on('error', (error) => workerLogger.error({ err: error }, 'worker error'));

  workerLogger.info(
    { queue: QUEUE_NAME, concurrency: env.RECEIPT_WORKER_CONCURRENCY },
    'neuton vision worker ready',
  );

  const shutdown = async (signal: string) => {
    workerLogger.info(`${signal} received, closing worker`);
    await worker.close();
    await sqlClient.end({ timeout: 5 }).catch(() => { });
    // Flushes the Loki worker's last batch before the process exits (issue #99).
    await loggerFactory.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (isEntrypoint()) {
  startWorker();
}

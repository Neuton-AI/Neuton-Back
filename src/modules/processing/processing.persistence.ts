import type { ProcessingJob } from './contracts.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import { prepareSourcePreviews } from '../../lib/documentPreviews.js';
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
} from '../../db/schema/index.js';
import { type MediaJobData } from '../../lib/queue.js';

import { convertRecipeToBaseUnits } from '../../lib/recipeConversion.js';
import { publicFailureMessage } from '../../lib/jobErrors.js';
import { isHtmlSafe } from '../../lib/safeText.js';
import { money, quantity as qty, toNumber, unitCost } from '../../lib/money.js';
import { calculateRetailPrice, calculateUnitCost } from '../../lib/pricing.js';
import { findOrCreateInventoryItem as findOrCreateInventoryItemOn } from '../../lib/inventory.js';

import { workerLogger } from '../../lib/logger/index.js';

import {
  prepareRecipeFallbackPrices,
  persistRecipeFallbackPrices,
} from '../../lib/recipePriceFallback.js';
import { resolveRecipeInventoryLinks } from '../../lib/recipeInventory.js';
import { resolveUniqueRecipeName } from '../../lib/recipeName.js';

import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import { type ReceiptProgressStage } from '../../db/schema/receipts.js';
import { setUnitsData } from '../../lib/supermarket/conversion.js';
import { validateSourceLimits } from '../../lib/mediaUploads.js';

import type {
  ReceiptExtraction,
  RecipeExtraction,
  OrderExtraction,
} from '../../lib/gemini.js';
import type { Logger } from '../../lib/logger/types.js';
import type { WorkerDeps } from './processing.service.js';
export function committedLog(
  deps: WorkerDeps,
  log: Logger,
  meta: Record<string, unknown> | string,
  message?: string,
) {
  const effect = async () => {
    if (typeof meta === 'string') log.info(meta);
    else log.info({ event: 'document_processing_committed', ...meta }, message);
  };
  if (deps.afterCommit) deps.afterCommit(effect);
  else void effect();
}
export async function updateReceiptProgress(
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
    .where(
      and(eq(receipts.shopId, shopId), eq(receipts.storagePath, storagePath)),
    );
}

export async function startReceipt(
  deps: WorkerDeps,
  data: MediaJobData,
  storagePath: string,
  startedAt: Date,
  deadline: Date,
) {
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
    .where(
      and(
        eq(receipts.shopId, data.shopId),
        eq(receipts.storagePath, storagePath),
      ),
    );
}
export async function saveReceipt(
  deps: WorkerDeps,
  data: MediaJobData,
  job: ProcessingJob,
  storagePath: string,
  deadline: Date,
  extraction: ReceiptExtraction,
  itemsWithUnitsAmounts: ReturnType<typeof setUnitsData>,
  jobLogger: Logger,
) {
  await deps.db.transaction(async (tx) => {
    const receiptRows = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          eq(receipts.shopId, data.shopId),
          eq(receipts.storagePath, storagePath),
        ),
      )
      .limit(1);
    const receiptId = receiptRows[0]?.id;
    if (!receiptId) {
      jobLogger.warn('receipt row missing for storage path');
      return;
    }

    checkDeadline(deadline);
    await updateReceiptProgress(
      deps,
      data.shopId,
      storagePath,
      'validating',
      'Clearing previous line items',
    );
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
      } else if (
        unitPrice === null &&
        quantity !== null &&
        quantity !== 0 &&
        totalPrice !== null
      ) {
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
        srcUnitAmount:
          item.srcUnitAmount === null ? null : qty(item.srcUnitAmount),
        baseUnit: item.baseUnit,
        baseUnitAmount:
          item.baseUnitAmount === null ? null : qty(item.baseUnitAmount),
        rawSku: item.rawSku,
        confidence:
          item.confidence === null ? null : item.confidence.toFixed(3),
      });
    }

    checkDeadline(deadline);
    await updateReceiptProgress(
      deps,
      data.shopId,
      storagePath,
      'validating',
      'Saving receipt',
    );
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
        taxAmount:
          extraction.taxAmount === null ? null : money(extraction.taxAmount),
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
}
export async function claimRecipe(
  deps: WorkerDeps,
  data: MediaJobData,
  storagePath: string,
) {
  const claimRows = await deps.db
    .select({ id: recipes.id, status: recipes.status })
    .from(recipes)
    .where(
      and(
        eq(recipes.shopId, data.shopId),
        eq(recipes.storagePath, storagePath),
      ),
    )
    .limit(1);
  const existingRecipe = claimRows[0];

  // A completed extraction may be redelivered by the queue. Preserve its links
  // (and any subsequent manual verification) instead of extracting it again.
  if (
    existingRecipe?.status === 'unverified' ||
    existingRecipe?.status === 'verified'
  )
    return existingRecipe;

  if (existingRecipe) {
    await deps.db
      .update(recipes)
      .set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
      .where(eq(recipes.id, existingRecipe.id));
  }

  return existingRecipe;
}
export async function recipeShop(deps: WorkerDeps, shopId: string) {
  const shopRows = await deps.db
    .select({
      hourlyLaborCost: shops.hourlyLaborCost,
      targetProfitMargin: shops.targetProfitMargin,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  const shop = shopRows[0];

  return shop;
}
export function recipeLinks(
  deps: WorkerDeps,
  shopId: string,
  ingredients: ReturnType<typeof convertRecipeToBaseUnits>['ingredients'],
) {
  return resolveRecipeInventoryLinks(deps.db, shopId, ingredients);
}
export async function saveRecipe(
  deps: WorkerDeps,
  data: MediaJobData,
  storagePath: string,
  existingRecipe: { id: string; status: string } | undefined,
  extraction: RecipeExtraction,
  convertedRecipe: ReturnType<typeof convertRecipeToBaseUnits>,
  linkedIngredientIds: (string | null)[],
  fallbackPrices: Awaited<ReturnType<typeof prepareRecipeFallbackPrices>>,
  shop: Awaited<ReturnType<typeof recipeShop>>,
  jobLogger: Logger,
) {
  const {
    name,
    description,
    prepTimeMinutes,
    yieldQuantity,
    yieldUnit,
    allergens,
    steps,
  } = extraction;
  if (!name) throw new Error('Recipe extraction has no name');
  const safeName = name;
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
          yieldQuantity: qty(
            yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1,
          ),
          yieldUnit: yieldUnit ?? 'portion',
          allergens,
          steps,
          status: 'unverified',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(recipes.id, existingRecipe.id));

      // Replace ingredients
      await tx
        .delete(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, existingRecipe.id));

      const bill = convertedRecipe.ingredients.map((ingredient, index) => {
        const inventoryItemId = linkedIngredientIds[index] ?? null;
        return {
          shopId: data.shopId,
          recipeId: existingRecipe.id,
          inventoryItemId,
          rawName: ingredient.rawName,
          rawMaterialName: ingredient.rawMaterialName,
          quantity: qty(
            ingredient.quantity && ingredient.quantity > 0
              ? ingredient.quantity
              : 1,
          ),
          rawSrcUnit: ingredient.rawSrcUnit ?? 'unit',
          baseUnit: ingredient.baseUnit,
          baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
        };
      });

      await tx.insert(recipeIngredients).values(bill);
      await persistRecipeFallbackPrices(
        tx,
        data.shopId,
        existingRecipe.id,
        fallbackPrices,
      );
    });

    committedLog(
      deps,
      jobLogger,
      {
        recipeId: existingRecipe.id,
        hourlyLaborCost: shop?.hourlyLaborCost,
      },
      'recipe extracted and set to unverified',
    );
  } else {
    // Legacy fallback: no row exists, insert directly as 'unverified' with storagePath
    const inserted = await deps.db.transaction(async (tx) => {
      // The (shopId, name) unique index rejects a name already in the shop, so
      // suffix the duplicate ("Recipe Name (2)") instead of failing the job.
      const uniqueName = await resolveUniqueRecipeName(
        tx,
        data.shopId,
        safeName,
      );
      const newRecipe = await tx
        .insert(recipes)
        .values({
          shopId: data.shopId,
          name: uniqueName,
          description,
          prepTimeMinutes: Math.max(Math.round(prepTimeMinutes ?? 0), 0),
          yieldQuantity: qty(
            yieldQuantity && yieldQuantity > 0 ? yieldQuantity : 1,
          ),
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
          rawMaterialName:
            ingredient.rawMaterialName?.trim() || ingredient.rawName,
          quantity: qty(
            ingredient.quantity && ingredient.quantity > 0
              ? ingredient.quantity
              : 1,
          ),
          rawSrcUnit: ingredient.rawSrcUnit ?? 'unit',
          baseUnit: ingredient.baseUnit,
          baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
        };
      });

      await tx.insert(recipeIngredients).values(bill);
      await persistRecipeFallbackPrices(
        tx,
        data.shopId,
        recipe.id,
        fallbackPrices,
      );

      return recipe;
    });

    committedLog(
      deps,
      jobLogger,
      {
        recipeId: inserted.id,
        hourlyLaborCost: shop?.hourlyLaborCost,
      },
      'recipe drafted from document (legacy fallback)',
    );
  }
}
export async function applyOrderDocument(
  deps: WorkerDeps,
  data: MediaJobData,
  extraction: OrderExtraction,
  jobLogger: Logger,
) {
  if (!data.orderId) return;
  const orderRows = await deps.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, data.orderId),
        eq(orders.shopId, data.shopId),
        isNull(orders.deletedAt),
      ),
    )
    .limit(1);
  const order = orderRows[0];
  if (!order) {
    jobLogger.warn({ orderId: data.orderId }, 'target order not found');
    return;
  }
  // A late extraction must not replace approved snapshots or revive a cancellation.
  if (order.status !== 'processing') return;

  const recipeRows = await deps.db
    .select()
    .from(recipes)
    .where(and(eq(recipes.shopId, data.shopId), eq(recipes.isActive, true)));
  const byName = new Map(
    recipeRows.map((recipe) => [recipe.name.toLowerCase(), recipe]),
  );

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
    committedLog(deps, jobLogger, 'no order lines matched catalog recipes');
    return;
  }

  const ingredientRows = await deps.db
    .select({
      recipeId: recipeIngredients.recipeId,
      quantity: recipeIngredients.baseUnitAmount,
      averageUnitCost: recipeIngredientUnitCost,
    })
    .from(recipeIngredients)
    .leftJoin(
      inventoryItems,
      eq(inventoryItems.id, recipeIngredients.inventoryItemId),
    )
    .leftJoin(
      generalPrices,
      eq(generalPrices.id, recipeIngredients.generalPriceId),
    )
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
    if (!breakdown.costComplete)
      throw new Error(
        `Recipe ${row.recipe.name} has incomplete ingredient costs`,
      );
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

    const totalCost = priced.reduce(
      (sum, row) => sum + row.quantity * row.unitCost,
      0,
    );
    const subtotal = priced.reduce(
      (sum, row) => sum + row.quantity * row.unitPrice,
      0,
    );

    await tx
      .update(orders)
      .set({
        // Extraction text is written only while it carries no HTML (issue
        // #116): an image can feed the model markup, and the field it would
        // land in is rendered to every shop member. Unsafe values leave the
        // order exactly as it was.
        ...(extraction.customerName &&
        !order.customerName &&
        isHtmlSafe(extraction.customerName)
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

  committedLog(
    deps,
    jobLogger,
    { orderId: order.id, lines: priced.length },
    'order auto-filled',
  );
}
export async function recordTerminalFailure(
  deps: WorkerDeps,
  data: MediaJobData,
  error: unknown,
): Promise<void> {
  const storagePath = data.storagePath;
  if (!storagePath) return;

  const message = publicFailureMessage(error);
  const isTimeout =
    error instanceof Error && error.message.includes('deadline exceeded');
  try {
    if (data.uploadId) {
      const [upload] = await deps.db
        .select({ processedAt: mediaUploads.processedAt })
        .from(mediaUploads)
        .where(
          and(
            eq(mediaUploads.id, data.uploadId),
            eq(mediaUploads.shopId, data.shopId),
          ),
        )
        .limit(1);
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
        .where(
          and(
            eq(receipts.shopId, data.shopId),
            eq(receipts.storagePath, storagePath),
            inArray(receipts.status, ['pending', 'processing', 'failed']),
          ),
        );
    } else if (data.kind === 'recipe' || data.kind === 'product') {
      await deps.db
        .update(recipes)
        .set({
          status: 'failed',
          errorMessage: message.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(recipes.shopId, data.shopId),
            eq(recipes.storagePath, storagePath),
            inArray(recipes.status, ['pending', 'processing', 'failed']),
          ),
        );
    }
  } catch (updateError) {
    workerLogger
      .child({
        kind: data.kind,
        shopId: data.shopId,
        userId: data.uploadedBy ?? undefined,
        traceId: data.traceId,
      })
      .error(
        {
          errorType:
            updateError instanceof Error
              ? updateError.constructor.name
              : typeof updateError,
        },
        'could not record terminal failure',
      );
  }
}

export async function findOrCreateInventoryItem(
  deps: WorkerDeps,
  shopId: string,
  rawName: string,
  unit: string | null,
): Promise<string | null> {
  return findOrCreateInventoryItemOn(deps.db, shopId, rawName, unit);
}

export function checkDeadline(deadline: Date | null) {
  if (deadline && new Date() > deadline)
    throw new Error('Processing deadline exceeded');
}

export async function processGroup(
  deps: WorkerDeps,
  data: MediaJobData,
  operation: (deps: WorkerDeps, data: MediaJobData) => Promise<void>,
) {
  await deps.db.transaction(async (tx) => {
    const [association] = await tx
      .select()
      .from(mediaUploads)
      .where(
        and(
          eq(mediaUploads.id, data.uploadId!),
          eq(mediaUploads.shopId, data.shopId),
        ),
      )
      .limit(1);
    if (!association || association.processedAt) return;
    const documentTable =
      association.kind === 'receipt'
        ? receipts
        : association.kind === 'order'
          ? orders
          : recipes;
    const documentId =
      association.receiptId ?? association.recipeId ?? association.orderId;
    if (!documentId) throw new Error('Upload has no associated document');
    // Deletion and processing share document -> upload lock order.
    const [document] = await tx
      .select({ id: documentTable.id })
      .from(documentTable)
      .where(
        and(
          eq(documentTable.id, documentId),
          eq(documentTable.shopId, data.shopId),
        ),
      )
      .limit(1)
      .for('update');
    if (!document) return;
    const [upload] = await tx
      .select()
      .from(mediaUploads)
      .where(
        and(
          eq(mediaUploads.id, data.uploadId!),
          eq(mediaUploads.shopId, data.shopId),
        ),
      )
      .limit(1)
      .for('update');
    if (!upload || upload.processedAt) return;
    if (
      (upload.receiptId ?? upload.recipeId ?? upload.orderId) !== documentId ||
      upload.kind !== association.kind
    ) {
      throw new Error('Upload document association changed during processing');
    }
    if (!upload.queuedAt)
      throw new Error('Document has not completed uploading');
    validateSourceLimits(upload.sources);
    const first = upload.sources[0]!;
    const sourceBytes = new Map<string, Uint8Array>();
    await operation(
      {
        ...deps,
        db: tx as unknown as Database,
        afterCommit: deps.afterCommit,
        getObjectBytes: async (path) => {
          const bytes = await deps.getObjectBytes(path);
          sourceBytes.set(path, bytes);
          return bytes;
        },
      },
      {
        ...data,
        kind: upload.kind,
        sources: upload.sources,
        storagePath: first.storagePath,
        contentType: first.contentType,
        originalFilename: first.originalFilename,
        orderId: upload.orderId ?? undefined,
      },
    );
    const createPreview = deps.createSourcePreview;
    const sources = createPreview
      ? await prepareSourcePreviews(
          upload.sources,
          async (source) => {
            const bytes = sourceBytes.get(source.storagePath);
            if (!bytes) throw new Error('Source bytes unavailable');
            return createPreview(source, bytes);
          },
          (source) => {
            workerLogger.warn({
              event: 'document_preview_failed', shopId: data.shopId, uploadId: upload.id,
              sourceId: source.sourceId, contentType: source.contentType,
            }, 'preview unavailable; original retained');
          },
        )
      : upload.sources;
    await tx
      .update(mediaUploads)
      .set({ processedAt: new Date(), sources })
      .where(eq(mediaUploads.id, upload.id));
  });
}

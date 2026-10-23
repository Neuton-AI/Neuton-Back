import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import {
  inventoryItems,
  generalPrices,
  recipeIngredients,
  recipes,
  mediaUploads,
} from '../db/schema/index.js';
import { currentShop, currentUser, currentRole } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound, conflict } from '../lib/errors.js';
import { htmlFree } from '../lib/safeText.js';
import { deleteObject } from '../lib/storage.js';
import { quantity as qty, unitCost } from '../lib/money.js';
import { defaultReceiptsDeps } from './receipts.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import { CatalogService, type CatalogAfterCommit } from '../modules/catalog/catalog.service.js';
import { CatalogPersistence, type CatalogTransaction } from '../modules/catalog/catalog.persistence.js';
import { createCategorySchema, inventoryQuerySchema, recipeQuerySchema, recipeIdSchema, recipeSchema, recipePatchSchema, recipeIngredientSchema } from '../modules/catalog/contracts.js';
import { prepareBarcodePrice } from '../lib/recipeBarcodePrice.js';
import { manualProductSchema, prepareManualProduct } from '../lib/manualProduct.js';
import { searchProduct } from '../lib/supermarket/prices.js';
import { assertCatalogLinks } from '../lib/catalogLinks.js';
import { adjustInventory, inventoryAdjustmentSchema } from '../lib/inventoryAdjustments.js';

/**
 * The schema refusing to erase a recipe is an FK `23503`, and that refusal is
 * the signal to fall back rather than fail: `order_items.recipe_id` is
 * `ON DELETE RESTRICT` precisely because order lines are sales history.
 *
 * postgres.js puts `code` on the error itself; drizzle may wrap it, so the
 * cause chain is walked before deciding this is not the case we are looking for.
 */
function isForeignKeyViolation(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 3; depth += 1) {
    if (
      typeof candidate === 'object' &&
      'code' in candidate &&
      (candidate as { code?: unknown }).code === '23503'
    ) {
      return true;
    }
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

const inventorySchema = z.object({
  name: htmlFree(z.string().trim().min(1).max(160)),
  rawMaterialName: htmlFree(z.string().trim().min(1).max(160)),
  sku: htmlFree(z.string().trim().max(64)).nullable().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  unit: z.enum(['kg', 'g', 'l', 'ml', 'unit', 'pack']),
  baseUnit: htmlFree(z.string().trim().min(1).max(24)),
  baseUnitAmount: z.number().finite().nonnegative().max(9999999999.99),
  baseUnitCost: z.number().finite().nonnegative().max(999999999999.999999),
  currentQuantity: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).nullable().optional(),
  lastUnitCost: z.coerce.number().min(0).nullable().optional(),
  averageUnitCost: z.coerce.number().min(0).nullable().optional(),
});

const inventoryPatchSchema = inventorySchema.partial();

declare module 'fastify' {
  interface FastifyRequest {
    catalogTransaction?: { db: CatalogTransaction; afterCommit: CatalogAfterCommit };
  }
}

function catalogActor(request: FastifyRequest): ActorContext {
  return {
    shop: currentShop(request), user: currentUser(request), role: currentRole(request),
    requestId: request.id, traceId: request.traceId ?? request.id,
    ipAddress: request.ip, log: request.log,
  };
}

function catalogService(request: FastifyRequest): CatalogService {
  const service = new CatalogService(new CatalogPersistence((request.receiptsDeps ?? defaultReceiptsDeps).db));
  return request.catalogTransaction
    ? service.inTransaction(request.catalogTransaction.db, request.catalogTransaction.afterCommit)
    : service;
}

export const catalogRoutes: FastifyPluginAsync<{ searchProduct?: typeof searchProduct }> = async (app, options) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [app.authenticate, app.resolveShop, app.requireRole(['owner', 'admin'])],
  };

  app.get('/categories', guards, async (request) =>
    catalogService(request).categories(catalogActor(request)));

  app.post('/categories', mutationGuards, async (request, reply) => {
    const result = await catalogService(request).createCategory(catalogActor(request), createCategorySchema.parse(request.body));
    return reply.code(201).send(result);
  });

  app.get('/recipes', guards, async (request) =>
    catalogService(request).recipes(catalogActor(request), recipeQuerySchema.parse(request.query)));

  app.post('/recipes', mutationGuards, async (request, reply) => {
    const result = await catalogService(request).createRecipe(catalogActor(request), recipeSchema.parse(request.body));
    return reply.code(201).send(result);
  });

  app.get('/recipes/:id', guards, async (request) =>
    catalogService(request).recipe(catalogActor(request), recipeIdSchema.parse(request.params).id));

  app.patch('/recipes/:id', mutationGuards, async (request) =>
    catalogService(request).editRecipe(catalogActor(request), recipeIdSchema.parse(request.params).id,
      recipePatchSchema.parse(request.body)));
  /** Create shop-owned pricing without recording a purchase or changing the saved recipe. */
  app.post('/recipes/:id/manual-product', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = manualProductSchema.parse(request.body);
    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const existing = await database.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id))).limit(1);
    if (!existing[0]) throw notFound('Recipe not found');
    const product = prepareManualProduct(body);
    // A duplicate must never silently overwrite existing stock or its price history.
    const [saved] = await database.insert(inventoryItems).values({ ...product, shopId: shop.id })
      .onConflictDoNothing({ target: [inventoryItems.shopId, inventoryItems.name] }).returning();
    if (!saved) throw conflict('A product with this name already exists in this shop. Use a different name.');
    return reply.code(201).send({ product: saved });
  });

  /** Price a draft ingredient by exact barcode without changing the saved recipe. */
  app.post('/recipes/:id/barcode-price', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      barcode: z.string().trim().regex(/^\d{4,64}$/),
      rawMaterialName: htmlFree(z.string().trim().min(1).max(160)),
      quantity: z.number().finite().positive().max(999999999.999),
      rawSrcUnit: htmlFree(z.string().trim().min(1).max(24)),
    }).parse(request.body);
    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const existing = await database.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id))).limit(1);
    if (!existing[0]) throw notFound('Recipe not found');

    // Feed I/O stays outside database transactions, as in recipe extraction.
    const { price, quantity } = await prepareBarcodePrice(body, options.searchProduct);
    const [saved] = await database.insert(generalPrices).values(price)
      .onConflictDoUpdate({ target: [generalPrices.rawMaterialName, generalPrices.sku], set: price })
      .returning({ id: generalPrices.id });
    if (!saved) throw new Error('general price upsert returned no row');
    return { price: { ...price, id: saved.id, quantity } };
  });

  /**
   * Deletes a recipe the only two ways the data model allows.
   *
   * The catalog row goes first: `recipe_ingredients` cascade with it and the
   * per-shop name — unique — goes back into the pool. What the schema will not
   * allow is erasing a recipe order lines still point at, so an FK `23503`
   * means "this recipe is part of the shop's sales history" and the delete
   * degrades to `is_active = false` instead of failing the request.
   *
   * The uploaded document leaves R2 either way: hard delete takes it with the
   * row, soft delete nulls `storage_path`/`image_url` before removing it so the
   * deactivated recipe never renders a pointer to an object that is gone.
   */
  app.delete('/recipes/:id', mutationGuards, async (request) => {
    const deps = request.receiptsDeps ?? defaultReceiptsDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await deps.db
      .select({ id: recipes.id, storagePath: recipes.storagePath })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)))
      .limit(1);
    const recipe = rows[0];
    if (!recipe) throw notFound('Recipe not found');

    const uploads = await deps.db.select({ sources: mediaUploads.sources }).from(mediaUploads)
      .where(and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shop.id)));
    const storagePaths = [...new Set([recipe.storagePath, ...uploads.flatMap((upload) => upload.sources.map((source) => source.storagePath))])]
      .filter((path): path is string => Boolean(path));
    let mode: 'hard' | 'soft';
    try {
      await deps.db.transaction(async (tx) => {
        await tx
          .delete(recipes)
          .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)));
      });
      mode = 'hard';
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      mode = 'soft';
      await deps.db
        .update(recipes)
        .set({ isActive: false, storagePath: null, imageUrl: null, updatedAt: new Date() })
        .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)));
      await deps.db.delete(mediaUploads).where(and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shop.id)));
    }

    // Row state first, object second, in both modes: a failed object delete
    // then leaks a file, while the other order would leave the row describing
    // an object that is already gone. It never fails the request — the recipe
    // is deactivated or deleted either way, and a 500 would only turn that
    // success into a doomed retry.
    for (const storagePath of storagePaths) {
      try {
        await deps.deleteObject(storagePath);
      } catch (error) {
        request.log.error({ err: error, recipeId: id }, 'recipe object cleanup failed');
      }
    }

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECIPE_DELETED',
      resourceId: id,
      ipAddress: request.ip,
      metadata: { mode },
    });

    return { ok: true, mode };
  });

  app.get('/inventory', guards, async (request) =>
    catalogService(request).inventory(catalogActor(request), inventoryQuerySchema.parse(request.query)));

  app.post('/inventory', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const body = inventorySchema.parse(request.body);

    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const rows = await database.transaction(async (tx) => {
      await assertCatalogLinks(tx, shop.id, body);
      return tx
      .insert(inventoryItems)
      .values({
        shopId: shop.id,
        name: body.name,
        rawMaterialName: body.rawMaterialName,
        sku: body.sku ?? null,
        imageUrl: body.imageUrl ?? null,
        categoryId: body.categoryId ?? null,
        unit: body.unit,
        baseUnit: body.baseUnit,
        baseUnitAmount: body.baseUnitAmount.toFixed(3),
        baseUnitCost: body.baseUnitCost.toFixed(6),
        currentQuantity: qty(body.currentQuantity),
        reorderLevel: body.reorderLevel === null || body.reorderLevel === undefined
          ? null
          : qty(body.reorderLevel),
        lastUnitCost: body.lastUnitCost === null || body.lastUnitCost === undefined
          ? null
          : unitCost(body.lastUnitCost),
        averageUnitCost:
          body.averageUnitCost === null || body.averageUnitCost === undefined
            ? null
            : unitCost(body.averageUnitCost),
      })
      .returning();
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'INVENTORY_UPDATED',
      resourceId: rows[0]?.id ?? null,
      ipAddress: request.ip,
      metadata: { action: 'create', name: body.name },
    });

    return reply.code(201).send({ item: rows[0] });
  });

  app.patch('/inventory/:id', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = inventoryPatchSchema.parse(request.body);

    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const updated = await database.transaction(async (tx) => {
      const existing = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)))
        .limit(1).for('update');
      if (!existing[0]) throw notFound('Inventory item not found');
      await assertCatalogLinks(tx, shop.id, body);

      const patch: Partial<typeof inventoryItems.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.rawMaterialName !== undefined) patch.rawMaterialName = body.rawMaterialName;
      if (body.sku !== undefined) patch.sku = body.sku ?? null;
      if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl ?? null;
      if (body.categoryId !== undefined) patch.categoryId = body.categoryId ?? null;
      if (body.unit !== undefined) patch.unit = body.unit;
      if (body.baseUnit !== undefined) patch.baseUnit = body.baseUnit;
      if (body.baseUnitAmount !== undefined) patch.baseUnitAmount = body.baseUnitAmount.toFixed(3);
      if (body.baseUnitCost !== undefined) patch.baseUnitCost = body.baseUnitCost.toFixed(6);
      if (body.currentQuantity !== undefined) patch.currentQuantity = qty(body.currentQuantity);
      if (body.reorderLevel !== undefined) {
        patch.reorderLevel = body.reorderLevel === null ? null : qty(body.reorderLevel);
      }
      if (body.lastUnitCost !== undefined) {
        patch.lastUnitCost = body.lastUnitCost === null ? null : unitCost(body.lastUnitCost);
      }
      if (body.averageUnitCost !== undefined) {
        patch.averageUnitCost =
          body.averageUnitCost === null ? null : unitCost(body.averageUnitCost);
      }

      return tx
        .update(inventoryItems)
        .set(patch)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)))
        .returning();
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'INVENTORY_UPDATED',
      resourceId: id,
      ipAddress: request.ip,
    });

    return { item: updated[0] };
  });

  app.delete('/inventory/:id', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await db
      .update(inventoryItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)));
    return { ok: true };
  });

  /** Verifies a recipe and saves reviewed ingredients in one transaction. */
  app.post('/recipes/:id/verify', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deps = request.receiptsDeps ?? defaultReceiptsDeps;

    const body = z
      .object({
        ingredients: z.array(recipeIngredientSchema).min(1).optional(),
      })
      .parse(request.body);

    const recipe = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: recipes.id, status: recipes.status })
        .from(recipes)
        .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound('Recipe not found');
      if (existing.status === 'verified') throw conflict('Recipe is already verified');
      await assertCatalogLinks(tx, shop.id, body);

      const patch: Partial<typeof recipes.$inferInsert> = {
        status: 'verified',
        errorMessage: null,
        updatedAt: new Date(),
      };

      const updated = await tx
        .update(recipes)
        .set(patch)
        .where(eq(recipes.id, id))
        .returning();
      if (!updated[0]) throw notFound('Recipe not found');

      if (body.ingredients) {
        await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, id));
        if (body.ingredients.length) {
          await tx.insert(recipeIngredients).values(
            body.ingredients.map((ingredient) => ({
              shopId: shop.id,
              recipeId: id,
              inventoryItemId: ingredient.inventoryItemId ?? null,
              generalPriceId: ingredient.generalPriceId ?? null,
              rawName: ingredient.rawName,
              rawMaterialName: ingredient.rawMaterialName?.trim() || ingredient.rawName,
              quantity: qty(ingredient.quantity),
              rawSrcUnit: ingredient.rawSrcUnit,
              baseUnit: ingredient.baseUnit ?? null,
              baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
            })),
          );
        }
      }

      return updated[0];
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECIPE_UPDATED',
      resourceId: id,
      ipAddress: request.ip,
      metadata: { action: 'verify' },
    });

    return { recipe };
  });

  /** Fully costed recipes available to the order item picker, including out-of-stock recipes. */
  app.get('/recipes/orderable', guards, async (request) =>
    catalogService(request).orderable(catalogActor(request)));

  /** Bulk stock adjustment used by the Inventory grid after manual counts. */
  app.post('/inventory/adjust', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const body = inventoryAdjustmentSchema.parse(request.body);
    const key = z.string().uuid().optional().parse(request.headers['idempotency-key']);
    return adjustInventory((request.receiptsDeps ?? defaultReceiptsDeps).db, {
      shopId: shop.id, userId: currentUser(request).id, key, adjustments: body.adjustments,
    });
  });
};

import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import {
  categories,
  inventoryItems,
  generalPrices,
  recipeIngredients,
  recipes,
  mediaUploads,
} from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound, conflict } from '../lib/errors.js';
import { htmlFree } from '../lib/safeText.js';
import { deleteObject } from '../lib/storage.js';
import { quantity as qty, toNumber, unitCost } from '../lib/money.js';
import { defaultReceiptsDeps } from './receipts.js';
import { costRecipe } from '../modules/catalog/costing.js';
import { convertEditedIngredients } from '../lib/recipeEdits.js';
import { prepareBarcodePrice } from '../lib/recipeBarcodePrice.js';
import { manualProductSchema, prepareManualProduct } from '../lib/manualProduct.js';
import { searchProduct } from '../lib/supermarket/prices.js';
import { assertCatalogLinks } from '../lib/catalogLinks.js';
import { adjustInventory, inventoryAdjustmentSchema } from '../lib/inventoryAdjustments.js';

const recipeIngredientSchema = z.object({
  inventoryItemId: z.string().uuid().nullable().optional(),
  generalPriceId: z.string().uuid().nullable().optional(),
  rawName: htmlFree(z.string().trim().min(1).max(160)),
  rawMaterialName: htmlFree(z.string().trim().min(1).max(160)).optional(),
  quantity: z.coerce.number().positive(),
  rawSrcUnit: htmlFree(z.string().trim().min(1).max(24)),
  baseUnit: z.enum(['g', 'ml', 'each']).nullable().optional(),
  baseUnitAmount: z.number().finite().positive().max(999999999999.999).nullable().optional(),
}).refine((ingredient) => !(ingredient.inventoryItemId && ingredient.generalPriceId), 'Choose one ingredient price source');

const recipeSchema = z.object({
  name: htmlFree(z.string().trim().min(1).max(160)),
  description: htmlFree(z.string().trim().max(2_000)).nullable().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  prepTimeMinutes: z.coerce.number().int().min(0).max(10_000).default(0),
  yieldQuantity: z.coerce.number().positive().max(100_000).default(1),
  yieldUnit: htmlFree(z.string().trim().min(1).max(24)).default('portion'),
  targetMarginPct: z.coerce.number().min(0).max(999).nullable().optional(),
  allergens: z.array(htmlFree(z.string().trim().min(1).max(40))).max(20).default([]),
  steps: z.array(z.object({
    stepNumber: z.number().int().positive(),
    instruction: htmlFree(z.string().trim().min(1).max(20_000)),
  })).max(500).refine((steps) => steps.every((step, index) => step.stepNumber === index + 1), 'Steps must be numbered in order').optional(),
  ingredients: z.array(recipeIngredientSchema).min(1),
});

const recipePatchSchema = recipeSchema.partial();

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

export const catalogRoutes: FastifyPluginAsync<{ searchProduct?: typeof searchProduct }> = async (app, options) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [app.authenticate, app.resolveShop, app.requireRole(['owner', 'admin'])],
  };

  app.get('/categories', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select()
      .from(categories)
      .where(eq(categories.shopId, shop.id))
      .orderBy(asc(categories.name));
    return { categories: rows };
  });

  app.post('/categories', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const body = z
      .object({ name: htmlFree(z.string().trim().min(1).max(80)) })
      .parse(request.body);
    const rows = await db
      .insert(categories)
      .values({ shopId: shop.id, name: body.name })
      .returning();
    return reply.code(201).send({ category: rows[0] });
  });

  app.get('/recipes', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({
        search: z.string().trim().max(120).optional(),
        includeInactive: z.coerce.boolean().default(false),
        includeUnverified: z.coerce.boolean().default(false),
      })
      .parse(request.query);

    const conditions = [eq(recipes.shopId, shop.id)];
    if (!query.includeInactive) conditions.push(eq(recipes.isActive, true));
    if (!query.includeUnverified) conditions.push(eq(recipes.status, 'verified'));
    if (query.search) {
      conditions.push(sql`${recipes.name} ilike ${`%${query.search}%`}`);
    }

    const rows = await db
      .select()
      .from(recipes)
      .where(and(...conditions))
      .orderBy(asc(recipes.name));

    const costed = await Promise.all(
      rows.map((recipe) =>
        costRecipe(shop.id, recipe, shop.targetProfitMargin, shop.hourlyLaborCost),
      ),
    );

    return {
      recipes: rows.map((recipe, index) => ({ ...recipe, costing: costed[index] })),
    };
  });

  app.post('/recipes', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const body = recipeSchema.parse(request.body);

    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const created = await database.transaction(async (tx) => {
      await assertCatalogLinks(tx, shop.id, body);
      const inserted = await tx
        .insert(recipes)
        .values({
          shopId: shop.id,
          name: body.name,
          description: body.description ?? null,
          imageUrl: body.imageUrl ?? null,
          categoryId: body.categoryId ?? null,
          prepTimeMinutes: body.prepTimeMinutes,
          yieldQuantity: qty(body.yieldQuantity),
          yieldUnit: body.yieldUnit,
          targetMarginPct:
            body.targetMarginPct === null || body.targetMarginPct === undefined
              ? null
              : body.targetMarginPct.toFixed(2),
          allergens: body.allergens,
          steps: body.steps ?? [],
          status: 'pending',
        })
        .returning();

      const recipe = inserted[0];
      if (!recipe) throw new Error('Recipe insert returned no row');

      await tx.insert(recipeIngredients).values(
        body.ingredients.map((ingredient) => ({
          shopId: shop.id,
          recipeId: recipe.id,
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

      return recipe;
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'RECIPE_CREATED',
      resourceId: created.id,
      ipAddress: request.ip,
    });

    return reply.code(201).send({ recipe: created });
  });

  app.get('/recipes/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select()
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)))
      .limit(1);
    const recipe = rows[0];
    if (!recipe) throw notFound('Recipe not found');

    const costing = await costRecipe(
      shop.id,
      recipe,
      shop.targetProfitMargin,
      shop.hourlyLaborCost,
    );
    const [upload] = await db.select({ sources: mediaUploads.sources }).from(mediaUploads)
      .where(and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shop.id))).limit(1);
    return { recipe: { ...recipe, costing, sources: upload?.sources ?? [] } };
  });

  app.patch('/recipes/:id', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = recipePatchSchema.parse(request.body);
    const database = (request.receiptsDeps ?? defaultReceiptsDeps).db;
    const ingredients = body.ingredients && convertEditedIngredients(body.ingredients);

    const patch: Partial<typeof recipes.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl ?? null;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId ?? null;
    if (body.prepTimeMinutes !== undefined) patch.prepTimeMinutes = body.prepTimeMinutes;
    if (body.yieldQuantity !== undefined) patch.yieldQuantity = qty(body.yieldQuantity);
    if (body.yieldUnit !== undefined) patch.yieldUnit = body.yieldUnit;
    if (body.targetMarginPct !== undefined) {
      patch.targetMarginPct =
        body.targetMarginPct === null ? null : body.targetMarginPct.toFixed(2);
    }
    if (body.allergens !== undefined) patch.allergens = body.allergens;
    if (body.steps !== undefined) patch.steps = body.steps ?? [];

    const updated = await database.transaction(async (tx) => {
      const existing = await tx.select({ id: recipes.id }).from(recipes)
        .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)))
        .for('update').limit(1);
      if (!existing[0]) throw notFound('Recipe not found');

      await assertCatalogLinks(tx, shop.id, { categoryId: body.categoryId, ingredients });

      const rows = await tx.update(recipes).set(patch)
        .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id))).returning();
      if (!rows[0]) throw notFound('Recipe not found');

      if (ingredients !== undefined) {
        await tx
          .delete(recipeIngredients)
          .where(and(eq(recipeIngredients.recipeId, id), eq(recipeIngredients.shopId, shop.id)));
        if (ingredients.length) {
          await tx.insert(recipeIngredients).values(
            ingredients.map((ingredient) => ({
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
      return rows[0];
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'RECIPE_UPDATED',
      resourceId: id,
      ipAddress: request.ip,
    });

    return { recipe: updated };
  });

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

  app.get('/inventory', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({
        search: z.string().trim().max(120).optional(),
        lowStockOnly: z.coerce.boolean().default(false),
        includeInactive: z.coerce.boolean().default(false),
      })
      .parse(request.query);

    const conditions = [eq(inventoryItems.shopId, shop.id)];
    if (!query.includeInactive) conditions.push(eq(inventoryItems.isActive, true));
    if (query.search) {
      conditions.push(sql`${inventoryItems.name} ilike ${`%${query.search}%`}`);
    }
    if (query.lowStockOnly) {
      conditions.push(
        sql`${inventoryItems.reorderLevel} is not null and ${inventoryItems.currentQuantity} <= ${inventoryItems.reorderLevel}`,
      );
    }

    const rows = await db
      .select()
      .from(inventoryItems)
      .where(and(...conditions))
      .orderBy(asc(inventoryItems.name));

    return {
      items: rows.map((item) => ({
        ...item,
        isLowStock:
          item.reorderLevel !== null &&
          toNumber(item.currentQuantity) <= toNumber(item.reorderLevel),
      })),
    };
  });

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

  /** Recipes that can currently be produced from stock — powers the order item picker. */
  app.get('/recipes/orderable', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select({
        id: recipes.id,
        name: recipes.name,
        imageUrl: recipes.imageUrl,
        yieldQuantity: recipes.yieldQuantity,
        yieldUnit: recipes.yieldUnit,
      })
      .from(recipes)
      .where(and(eq(recipes.shopId, shop.id), eq(recipes.isActive, true), eq(recipes.status, 'verified')))
      .orderBy(asc(recipes.name));

    const costed = await Promise.all(
      rows.map(async (row) => {
        const full = await db
          .select()
          .from(recipes)
          .where(eq(recipes.id, row.id))
          .limit(1);
        const recipe = full[0];
        if (!recipe) return null;
        const costing = await costRecipe(
          shop.id,
          recipe,
          shop.targetProfitMargin,
          shop.hourlyLaborCost,
        );
        if (!costing.costComplete) return null;
        return { ...row, costComplete: true, unitCost: costing.unitCost, retailPrice: costing.retailPrice };
      }),
    );

    return { recipes: costed.filter((r): r is NonNullable<typeof r> => r !== null) };
  });

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

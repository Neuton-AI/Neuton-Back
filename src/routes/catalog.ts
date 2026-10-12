import { normalizeMeasurement, parseNumber } from '../lib/measurements.js';
import { ingredientConversions } from '../db/schema/index.js';
import { costRecipe } from '../lib/recipeCosting.js';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db, type Database } from '../db/client.js';
import {
  categories,
  inventoryItems,
  generalPrices,
  recipeIngredients,
  recipes,
} from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound, conflict, forbidden, badRequest } from '../lib/errors.js';
import { htmlFree } from '../lib/safeText.js';
import { deleteObject } from '../lib/storage.js';
import { quantity as qty, toNumber, unitCost } from '../lib/money.js';
import {
  calculateRetailPrice,
  calculateUnitCost,
  checkBatchStock,
} from '../lib/pricing.js';
import { verifyReceipt, type VerifyReceiptInput } from '../lib/verifyReceipt.js';
import { defaultReceiptsDeps, verifyItemSchema } from './receipts.js';
import { recipeIngredientUnitCost } from '../lib/recipeCostQuery.js';

const recipeIngredientSchema = z.object({
  inventoryItemId: z.string().uuid().nullable().optional(),
  rawName: htmlFree(z.string().trim().min(1).max(160)),
  searchAbleName: htmlFree(z.string().trim().min(1).max(160)).optional(),
  measurementContext: z.object({ convention: z.enum(['us', 'metric', 'imperial']).nullable().optional(), qualifier: htmlFree(z.string().max(100)).nullable().optional(), alternatives: z.array(htmlFree(z.string().max(160))).optional() }).optional(),
  quantity: z.coerce.number().positive(),
  unit: htmlFree(z.string().trim().min(1).max(24)),
});

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
  instructions: htmlFree(z.string().trim().max(20_000)).nullable().optional(),
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
  sku: htmlFree(z.string().trim().max(64)).nullable().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  unit: z.enum(['kg', 'g', 'l', 'ml', 'unit', 'pack', 'each']),
  reconcileMeasurement: z.boolean().optional(),
  currentQuantity: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).nullable().optional(),
  lastUnitCost: z.coerce.number().min(0).nullable().optional(),
  averageUnitCost: z.coerce.number().min(0).nullable().optional(),
});

const inventoryPatchSchema = inventorySchema.partial();

export { costRecipe } from '../lib/recipeCosting.js';

export const catalogRoutes: FastifyPluginAsync = async (app) => {
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

    const created = await db.transaction(async (tx) => {
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
          instructions: body.instructions ?? null,
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
          rawName: ingredient.rawName,
          searchAbleName: ingredient.searchAbleName?.trim() || ingredient.rawName,
          quantity: qty(ingredient.quantity),
          unit: ingredient.unit,
              measurementContext: ingredient.measurementContext ?? null,
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
    return { recipe: { ...recipe, costing } };
  });

  app.patch('/recipes/:id', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = recipePatchSchema.parse(request.body);

    const existing = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)))
      .limit(1);
    if (!existing[0]) throw notFound('Recipe not found');

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
    if (body.instructions !== undefined) patch.instructions = body.instructions ?? null;

    const updated = await db
      .update(recipes)
      .set(patch)
      .where(eq(recipes.id, id))
      .returning();

    if (body.ingredients !== undefined) {
      await db.transaction(async (tx) => {
        await tx
          .delete(recipeIngredients)
          .where(eq(recipeIngredients.recipeId, id));
        if (body.ingredients?.length) {
          await tx.insert(recipeIngredients).values(
            body.ingredients.map((ingredient) => ({
              shopId: shop.id,
              recipeId: id,
              inventoryItemId: ingredient.inventoryItemId ?? null,
              rawName: ingredient.rawName,
              searchAbleName: ingredient.searchAbleName?.trim() || ingredient.rawName,
              quantity: qty(ingredient.quantity),
              unit: ingredient.unit,
              measurementContext: ingredient.measurementContext ?? null,
            })),
          );
        }
      });
    }

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'RECIPE_UPDATED',
      resourceId: id,
      ipAddress: request.ip,
    });

    return { recipe: updated[0] };
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
    }

    // Row state first, object second, in both modes: a failed object delete
    // then leaks a file, while the other order would leave the row describing
    // an object that is already gone. It never fails the request — the recipe
    // is deactivated or deleted either way, and a 500 would only turn that
    // success into a doomed retry.
    if (recipe.storagePath) {
      try {
        await deps.deleteObject(recipe.storagePath);
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
    const basis = normalizeMeasurement(1, body.unit).measurement;
    if (!basis) throw badRequest('Provide a mass, volume or count inventory basis');

    const rows = await db
      .insert(inventoryItems)
      .values({
        shopId: shop.id,
        name: body.name,
        sku: body.sku ?? null,
        imageUrl: body.imageUrl ?? null,
        categoryId: body.categoryId ?? null,
        unit: basis.unit,
        currentQuantity: qty(body.currentQuantity * basis.quantity),
        measurementStatus: 'ready',
        measurementEvidence: { source: 'confirmed-opening-balance', original: body, confirmedBy: currentUser(request).id },
        reorderLevel: body.reorderLevel === null || body.reorderLevel === undefined
          ? null
          : qty(body.reorderLevel * basis.quantity),
        lastUnitCost: body.lastUnitCost === null || body.lastUnitCost === undefined
          ? null
          : unitCost(body.lastUnitCost / basis.quantity),
        averageUnitCost:
          body.averageUnitCost === null || body.averageUnitCost === undefined
            ? null
            : unitCost(body.averageUnitCost / basis.quantity),
      })
      .returning();

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

    const existing = await db
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)))
      .limit(1);
    if (!existing[0]) throw notFound('Inventory item not found');

    const patch: Partial<typeof inventoryItems.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.sku !== undefined) patch.sku = body.sku ?? null;
    if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl ?? null;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId ?? null;
    const old = existing[0]!;
    if (body.unit !== undefined || body.reconcileMeasurement) {
      if (!body.reconcileMeasurement || body.currentQuantity === undefined || body.averageUnitCost == null || !body.unit) throw badRequest('Confirm the unit, opening quantity and average cost together to reconcile inventory');
      const basis = normalizeMeasurement(1, body.unit).measurement;
      if (!basis) throw badRequest('Unsupported opening balance unit');
      patch.unit = basis.unit;
      patch.currentQuantity = qty(body.currentQuantity * basis.quantity);
      patch.averageUnitCost = unitCost(body.averageUnitCost / basis.quantity);
      patch.lastUnitCost = body.lastUnitCost == null ? patch.averageUnitCost : unitCost(body.lastUnitCost / basis.quantity);
      patch.reorderLevel = body.reorderLevel == null ? null : qty(body.reorderLevel * basis.quantity);
      patch.measurementStatus = 'ready';
      patch.measurementEvidence = { source: 'confirmed-reconciliation', previous: old, original: body, confirmedBy: currentUser(request).id, confirmedAt: new Date().toISOString() };
    } else {
      if (body.currentQuantity !== undefined) patch.currentQuantity = qty(body.currentQuantity);
      if (body.reorderLevel !== undefined) patch.reorderLevel = body.reorderLevel === null ? null : qty(body.reorderLevel);
      if (body.lastUnitCost !== undefined) patch.lastUnitCost = body.lastUnitCost === null ? null : unitCost(body.lastUnitCost);
      if (body.averageUnitCost !== undefined) patch.averageUnitCost = body.averageUnitCost === null ? null : unitCost(body.averageUnitCost);
    }

    const updated = await db
      .update(inventoryItems)
      .set(patch)
      .where(eq(inventoryItems.id, id))
      .returning();

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: currentUser(request).id,
      eventType: 'INVENTORY_UPDATED',
      resourceId: id,
      ipAddress: request.ip,
    });

    return { item: updated[0] };
  });

  app.patch('/recipes/:recipeId/ingredients/:lineId/measurement', mutationGuards, async request => {
    const shop = currentShop(request);
    const { recipeId, lineId } = z.object({ recipeId: z.string().uuid(), lineId: z.string().uuid() }).parse(request.params);
    const profileSchema = z.object({ from: z.enum(['g', 'ml', 'each']), to: z.enum(['g', 'ml', 'each']), factor: z.number().positive(), qualifier: z.string().nullable().optional() });
    const body = z.object({ quantity: z.number().positive().optional(), unit: htmlFree(z.string().max(24)).optional(),
      convention: z.enum(['us', 'metric', 'imperial']).nullable().optional(),
      selectedAlternative: htmlFree(z.string().max(160)).optional(), inventoryItemId: z.string().uuid().optional(),
      profile: profileSchema.optional(), scope: z.enum(['recipe', 'ingredient', 'product']).default('recipe'),
    }).parse(request.body);
    return db.transaction(async tx => {
      const [row] = await tx.select().from(recipeIngredients).where(and(eq(recipeIngredients.id, lineId), eq(recipeIngredients.recipeId, recipeId), eq(recipeIngredients.shopId, shop.id))).for('update').limit(1);
      if (!row) throw notFound('Ingredient not found');
      const context = (row.measurementContext ?? {}) as import('../lib/recipeCosting.js').MeasurementContext;
      if (body.selectedAlternative && !context.alternatives?.includes(body.selectedAlternative)) throw badRequest('Select an original ingredient alternative');
      if (body.inventoryItemId) {
        const [item] = await tx.select().from(inventoryItems).where(and(eq(inventoryItems.id, body.inventoryItemId), eq(inventoryItems.shopId, shop.id))).limit(1);
        if (!item) throw notFound('Inventory item not found');
      }
      const profile = body.profile ? { ...body.profile, convention: body.convention ?? context.convention,
        source: 'shop-confirmed:' + currentUser(request).id, version: new Date().toISOString(), estimated: false } : undefined;
      const nextContext = { ...context,
        ...(body.convention !== undefined ? { convention: body.convention } : {}),
        ...(body.selectedAlternative ? { selectedAlternative: body.selectedAlternative } : {}),
        ...(profile ? { profile } : {}), confirmedBy: currentUser(request).id };
      // Changes are resolved from source fields on every read, never stale derived fields.
      await tx.update(recipeIngredients).set({
        ...(body.quantity !== undefined ? { quantity: qty(body.quantity) } : {}), ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.inventoryItemId ? { inventoryItemId: body.inventoryItemId, generalPriceId: null } : {}),
        ...(body.selectedAlternative ? { searchAbleName: body.selectedAlternative, inventoryItemId: body.inventoryItemId ?? null, generalPriceId: null } : {}),
        measurementContext: nextContext,
      }).where(eq(recipeIngredients.id, lineId));
      if (profile && body.scope !== 'recipe') {
        const itemId = body.inventoryItemId ?? row.inventoryItemId;
        if (body.scope === 'product' && !itemId) throw badRequest('Link an inventory product before saving its conversion');
        const scopeKey = body.scope === 'product' ? 'product:' + itemId : 'ingredient:' + (body.selectedAlternative ?? row.searchAbleName).trim().toLowerCase();
        const saved = { shopId: shop.id, scopeKey, profile, updatedAt: new Date() };
        await tx.insert(ingredientConversions).values(saved).onConflictDoUpdate({ target: [ingredientConversions.shopId, ingredientConversions.scopeKey], set: saved });
      }
      return { ok: true };
    });
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

  /**
   * Unified verification endpoint for receipts and recipes.
   * Single transaction with row lock, audit trail, and proper error codes.
   */
  app.post('/catalog/:type/:id/verify', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const { type, id } = z
      .object({
        type: z.enum(['receipt', 'recipe']),
        id: z.string().uuid(),
      })
      .parse(request.params);

    // Per-request DB override for tests (same seam as receipts routes)
    const deps = request.receiptsDeps ?? defaultReceiptsDeps;

    if (type === 'receipt') {
      const body = z
        .object({
          items: z.array(verifyItemSchema).min(1).max(500),
        })
        .parse(request.body);

      const outcome = await verifyReceipt({
        db: deps.db,
        shopId: shop.id,
        userId: user.id,
        receiptId: id,
        items: body.items,
      });

      await recordAuditSafe(app, {
        shopId: shop.id,
        userId: user.id,
        eventType: 'RECEIPT_PROCESSED',
        resourceId: id,
        ipAddress: request.ip,
        metadata: { accepted: outcome.accepted, rejected: outcome.rejected },
      });

      return reply.code(200).send(outcome);
    }

    // Recipe verification
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
              rawName: ingredient.rawName,
              searchAbleName: ingredient.searchAbleName?.trim() || ingredient.rawName,
              quantity: qty(ingredient.quantity),
              unit: ingredient.unit,
              measurementContext: ingredient.measurementContext ?? null,
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
        return { ...row, unitCost: costing.unitCost, retailPrice: costing.retailPrice, costingStatus: costing.measurementState, reasons: costing.reasons };
      }),
    );

    return { recipes: costed.filter((r): r is NonNullable<typeof r> => r !== null) };
  });

  /** Bulk stock adjustment used by the Inventory grid after manual counts. */
  app.post('/inventory/adjust', mutationGuards, async (request) => {
    const shop = currentShop(request);
    const body = z
      .object({
        adjustments: z
          .array(
            z.object({
              inventoryItemId: z.string().uuid(),
              deltaQuantity: z.coerce.number(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(request.body);

    const ids = body.adjustments.map((a) => a.inventoryItemId);
    const owned = await db
      .select()
      .from(inventoryItems)
      .where(and(inArray(inventoryItems.id, ids), eq(inventoryItems.shopId, shop.id)));

    const ownedIds = new Set(owned.map((row) => row.id));
    const applied: string[] = [];
    for (const adjustment of body.adjustments) {
      if (!ownedIds.has(adjustment.inventoryItemId)) continue;
      await db
        .update(inventoryItems)
        .set({
          currentQuantity: sql`greatest(${inventoryItems.currentQuantity} + ${adjustment.deltaQuantity}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, adjustment.inventoryItemId));
      applied.push(adjustment.inventoryItemId);
    }

    return { adjusted: applied.length, ids: applied };
  });
};

import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import {
  categories,
  inventoryItems,
  recipeIngredients,
  recipes,
} from '../db/schema/index.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { quantity as qty, toNumber, unitCost } from '../lib/money.js';import {
  calculateRetailPrice,
  calculateUnitCost,
  checkBatchStock,
} from '../lib/pricing.js';

const recipeIngredientSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().min(1).max(24),
});

const recipeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).nullable().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  prepTimeMinutes: z.coerce.number().int().min(0).max(10_000).default(0),
  yieldQuantity: z.coerce.number().positive().max(100_000).default(1),
  yieldUnit: z.string().trim().min(1).max(24).default('portion'),
  targetMarginPct: z.coerce.number().min(0).max(999).nullable().optional(),
  allergens: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  instructions: z.string().trim().max(20_000).nullable().optional(),
  ingredients: z.array(recipeIngredientSchema).min(1),
});

const recipePatchSchema = recipeSchema.partial();

const inventorySchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(64).nullable().optional(),
  imageUrl: z.string().trim().url().max(500).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  unit: z.enum(['kg', 'g', 'l', 'ml', 'unit', 'pack']),
  currentQuantity: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).nullable().optional(),
  lastUnitCost: z.coerce.number().min(0).nullable().optional(),
  averageUnitCost: z.coerce.number().min(0).nullable().optional(),
});

const inventoryPatchSchema = inventorySchema.partial();

async function costRecipe(
  shopId: string,
  recipe: typeof recipes.$inferSelect,
  shopMargin: string,
  hourlyLaborCost: string,
) {
  const ingredients = await db
    .select({
      name: inventoryItems.name,
      unit: recipeIngredients.unit,
      quantity: recipeIngredients.quantity,
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(recipeIngredients)
    .innerJoin(
      inventoryItems,
      eq(inventoryItems.id, recipeIngredients.inventoryItemId),
    )
    .where(
      and(
        eq(recipeIngredients.shopId, shopId),
        eq(recipeIngredients.recipeId, recipe.id),
      ),
    )
    .orderBy(asc(recipeIngredients.id));

  const breakdown = calculateUnitCost({
    ingredients: ingredients.map((i) => ({
      quantity: i.quantity,
      averageUnitCost: i.averageUnitCost,
    })),
    prepTimeMinutes: recipe.prepTimeMinutes,
    hourlyLaborCost,
    yieldQuantity: recipe.yieldQuantity,
  });

  const { retailPrice, appliedMarginPercent } = calculateRetailPrice(
    breakdown.unitCost,
    shopMargin,
    recipe.targetMarginPct,
  );

  const batchAvailable = ingredients.every((ingredient) => {
    const stock = checkBatchStock({
      requiredQuantity: toNumber(ingredient.quantity),
      currentQuantity: toNumber(ingredient.currentQuantity),
    });
    return stock.inStock;
  });

  return {
    unitCost: breakdown.unitCost,
    ingredientsCost: breakdown.ingredientsCost,
    laborCost: breakdown.laborCost,
    batchCost: breakdown.batchCost,
    retailPrice,
    appliedMarginPercent,
    yieldQuantity: toNumber(recipe.yieldQuantity),
    inStock: batchAvailable,
    ingredients: ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: toNumber(ingredient.quantity),
      unit: ingredient.unit,
      averageUnitCost: toNumber(ingredient.averageUnitCost),
      lineCost:
        Math.round(toNumber(ingredient.quantity) * toNumber(ingredient.averageUnitCost) * 10_000) /
        10_000,
      currentQuantity: toNumber(ingredient.currentQuantity),
    })),
  };
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };

  app.get('/categories', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select()
      .from(categories)
      .where(eq(categories.shopId, shop.id))
      .orderBy(asc(categories.name));
    return { categories: rows };
  });

  app.post('/categories', guards, async (request, reply) => {
    const shop = currentShop(request);
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const rows = await db
      .insert(categories)
      .values({ shopId: shop.id, name: body.name })
      .returning();
    return reply.code(201).send({ category: rows[0] });
  });

  app.get('/recipes', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({ search: z.string().trim().max(120).optional(), includeInactive: z.coerce.boolean().default(false) })
      .parse(request.query);

    const conditions = [eq(recipes.shopId, shop.id)];
    if (!query.includeInactive) conditions.push(eq(recipes.isActive, true));
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

  app.post('/recipes', guards, async (request, reply) => {
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
        })
        .returning();

      const recipe = inserted[0];
      if (!recipe) throw new Error('Recipe insert returned no row');

      await tx.insert(recipeIngredients).values(
        body.ingredients.map((ingredient) => ({
          shopId: shop.id,
          recipeId: recipe.id,
          inventoryItemId: ingredient.inventoryItemId,
          quantity: qty(ingredient.quantity),
          unit: ingredient.unit,
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

  app.patch('/recipes/:id', guards, async (request) => {
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
              inventoryItemId: ingredient.inventoryItemId,
              quantity: qty(ingredient.quantity),
              unit: ingredient.unit,
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

  app.delete('/recipes/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await db
      .update(recipes)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shop.id)));
    return { ok: true };
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

  app.post('/inventory', guards, async (request, reply) => {
    const shop = currentShop(request);
    const body = inventorySchema.parse(request.body);

    const rows = await db
      .insert(inventoryItems)
      .values({
        shopId: shop.id,
        name: body.name,
        sku: body.sku ?? null,
        imageUrl: body.imageUrl ?? null,
        categoryId: body.categoryId ?? null,
        unit: body.unit,
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

  app.patch('/inventory/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = inventoryPatchSchema.parse(request.body);

    const existing = await db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)))
      .limit(1);
    if (!existing[0]) throw notFound('Inventory item not found');

    const patch: Partial<typeof inventoryItems.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.sku !== undefined) patch.sku = body.sku ?? null;
    if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl ?? null;
    if (body.categoryId !== undefined) patch.categoryId = body.categoryId ?? null;
    if (body.unit !== undefined) patch.unit = body.unit;
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

  app.delete('/inventory/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await db
      .update(inventoryItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.shopId, shop.id)));
    return { ok: true };
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
      .where(and(eq(recipes.shopId, shop.id), eq(recipes.isActive, true)))
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
        return { ...row, unitCost: costing.unitCost, retailPrice: costing.retailPrice };
      }),
    );

    return { recipes: costed.filter((r): r is NonNullable<typeof r> => r !== null) };
  });

  /** Bulk stock adjustment used by the Inventory grid after manual counts. */
  app.post('/inventory/adjust', guards, async (request) => {
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
      .select({ id: inventoryItems.id })
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

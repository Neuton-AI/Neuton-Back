import { upsertReferencePrice } from '../../lib/referencePrices.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../db/client.js';
import type { ShopTransaction } from '../../db/types.js';
import type { ActorContext } from '../identity/contracts.js';
import { ShopOperation, type AfterShopCommit } from '../../db/shop-operation.js';
import type { ReadDatabase } from '../../db/types.js';
import { recipes, mediaUploads, recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import type { Recipe } from '../../db/schema/catalog.js';
import { notFound, conflict } from '../../lib/errors.js';
import { assertCatalogLinks } from '../../lib/catalogLinks.js';
import { quantity } from '../../lib/money.js';
import type { CreateRecipeInput, RecipeDto, RecipeQuery, RecipeSourceDto, RecipePatchInput, PreparedRecipeIngredient, VerifyRecipeInput } from './contracts.js';
import type { prepareManualProduct } from '../../lib/manualProduct.js';
import type { prepareBarcodePrice } from '../../lib/recipeBarcodePrice.js';
export const RECIPE_DATABASE = Symbol('RECIPE_DATABASE');

function ingredientValues(shopId: string, recipeId: string, ingredients: readonly PreparedRecipeIngredient[]) {
  return ingredients.map(ingredient => ({
    shopId, recipeId, inventoryItemId: ingredient.inventoryItemId ?? null,
    generalPriceId: ingredient.generalPriceId ?? null, rawName: ingredient.rawName,
    rawMaterialName: ingredient.rawMaterialName?.trim() || ingredient.rawName,
    quantity: quantity(ingredient.quantity), rawSrcUnit: ingredient.rawSrcUnit,
    baseUnit: ingredient.baseUnit ?? null, baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
  }));
}

function mapRecipe(recipe: Recipe): RecipeDto {
  return {
    id: recipe.id, shopId: recipe.shopId, categoryId: recipe.categoryId,
    name: recipe.name, description: recipe.description, imageUrl: recipe.imageUrl,
    prepTimeMinutes: recipe.prepTimeMinutes, yieldQuantity: recipe.yieldQuantity,
    yieldUnit: recipe.yieldUnit, targetMarginPct: recipe.targetMarginPct,
    allergens: recipe.allergens?.slice() ?? null,
    steps: recipe.steps.map(step => ({ stepNumber: step.stepNumber, instruction: step.instruction })),
    isActive: recipe.isActive, status: recipe.status, storagePath: recipe.storagePath,
    errorMessage: recipe.errorMessage,
    createdAt: recipe.createdAt.toISOString(), updatedAt: recipe.updatedAt.toISOString(),
  };
}
@Injectable()
export class RecipePersistence {
  constructor(@Inject(RECIPE_DATABASE) source: Database | ShopTransaction) { this.access = new ShopOperation(source); }
  private readonly access: ShopOperation;
  get database() { return this.access.database; }
  get scope() { return this.access.scope; }
  inShop<T>(actor: ActorContext, work: (persistence: RecipePersistence, actor: ActorContext, afterCommit?: AfterShopCommit) => Promise<T>): Promise<T> {
    return this.access.run(actor, (scope, currentActor, afterCommit) => work(new RecipePersistence(scope), currentActor, afterCommit));
  }

  async createRecipe(shopId: string, input: CreateRecipeInput): Promise<RecipeDto> {
    const tx = this.database;
    await assertCatalogLinks(tx, shopId, input);
    const [recipe] = await tx.insert(recipes).values({
      shopId, name: input.name, description: input.description ?? null,
      imageUrl: input.imageUrl ?? null, categoryId: input.categoryId ?? null,
      prepTimeMinutes: input.prepTimeMinutes, yieldQuantity: quantity(input.yieldQuantity),
      yieldUnit: input.yieldUnit, targetMarginPct: input.targetMarginPct?.toFixed(2) ?? null,
      allergens: input.allergens, steps: input.steps ?? [], status: 'pending',
    }).returning();
    if (!recipe) throw new Error('Recipe insert returned no row');
    await tx.insert(recipeIngredients).values(ingredientValues(shopId, recipe.id, input.ingredients));
    return mapRecipe(recipe);
  }

  async editRecipe(
    shopId: string, id: string, input: Omit<RecipePatchInput, 'ingredients'>,
    ingredients?: readonly PreparedRecipeIngredient[],
  ): Promise<RecipeDto> {
    const patch: Partial<typeof recipes.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl ?? null;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId ?? null;
    if (input.prepTimeMinutes !== undefined) patch.prepTimeMinutes = input.prepTimeMinutes;
    if (input.yieldQuantity !== undefined) patch.yieldQuantity = quantity(input.yieldQuantity);
    if (input.yieldUnit !== undefined) patch.yieldUnit = input.yieldUnit;
    if (input.targetMarginPct !== undefined) {
      patch.targetMarginPct =
        input.targetMarginPct === null ? null : input.targetMarginPct.toFixed(2);
    }
    if (input.allergens !== undefined) patch.allergens = input.allergens;
    if (input.steps !== undefined) patch.steps = input.steps ?? [];
    const tx = this.database;
    const existing = await tx.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
      .for('update').limit(1);
    if (!existing[0]) throw notFound('Recipe not found');

    await assertCatalogLinks(tx, shopId, { categoryId: input.categoryId, ingredients });

    const rows = await tx.update(recipes).set(patch)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId))).returning();
    if (!rows[0]) throw notFound('Recipe not found');

    if (ingredients !== undefined) {
      await tx
        .delete(recipeIngredients)
        .where(and(eq(recipeIngredients.recipeId, id), eq(recipeIngredients.shopId, shopId)));
      if (ingredients.length) {
        await tx.insert(recipeIngredients).values(ingredientValues(shopId, id, ingredients));
      }
    }
    const updated = await rows[0];

    return mapRecipe(updated);
  }

  async verifyRecipe(shopId: string, id: string, input: VerifyRecipeInput): Promise<RecipeDto> {
    const tx = this.database;
    const rows = await tx
      .select({ id: recipes.id, status: recipes.status })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound('Recipe not found');
    if (existing.status === 'verified') throw conflict('Recipe is already verified');
    await assertCatalogLinks(tx, shopId, input);

    const patch: Partial<typeof recipes.$inferInsert> = {
      status: 'verified',
      errorMessage: null,
      updatedAt: new Date(),
    };

    const updated = await tx
      .update(recipes)
      .set(patch)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
      .returning();
    if (!updated[0]) throw notFound('Recipe not found');

    if (input.ingredients) {
      await tx.delete(recipeIngredients).where(and(eq(recipeIngredients.recipeId, id), eq(recipeIngredients.shopId, shopId)));
      if (input.ingredients.length) {
        await tx.insert(recipeIngredients).values(ingredientValues(shopId, id, input.ingredients));
      }
    }
    const recipe = await updated[0];

    return mapRecipe(recipe);
  }

  async listRecipes(shopId: string, query: RecipeQuery): Promise<RecipeDto[]> {
    const conditions = [eq(recipes.shopId, shopId)];
    if (!query.includeInactive) conditions.push(eq(recipes.isActive, true));
    if (!query.includeUnverified) conditions.push(eq(recipes.status, 'verified'));
    if (query.search) conditions.push(sql`${recipes.name} ilike ${`%${query.search}%`}`);
    const rows = await this.database.select().from(recipes)
      .where(and(...conditions)).orderBy(asc(recipes.name));
    return rows.map(mapRecipe);
  }

  async recipe(shopId: string, id: string): Promise<RecipeDto> {
    const [recipe] = await this.database.select().from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId))).limit(1);
    if (!recipe) throw notFound('Recipe not found');
    return mapRecipe(recipe);
  }

  async recipeSources(shopId: string, id: string): Promise<RecipeSourceDto[]> {
    const [upload] = await this.database.select({ sources: mediaUploads.sources }).from(mediaUploads)
      .where(and(eq(mediaUploads.recipeId, id), eq(mediaUploads.shopId, shopId))).limit(1);
    return (upload?.sources ?? []).map(source => ({
      sourceId: source.sourceId, storagePath: source.storagePath, contentType: source.contentType,
      originalFilename: source.originalFilename, byteSize: source.byteSize,
      ...(source.preview ? { preview: source.preview } : {}),
    }));
  }

  async assertRecipe(shopId: string, id: string) {
    const [recipe] = await this.database
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.shopId, shopId)))
      .limit(1);
    if (!recipe) throw notFound('Recipe not found');
  }
  async manualProduct(
    product: ReturnType<typeof prepareManualProduct>,
  ) {
    const id = await upsertReferencePrice(this.database, product);
    return { ...product, id, name: product.rawName };
  }
  async barcodePrice(
    price: Awaited<ReturnType<typeof prepareBarcodePrice>>['price'],
  ) {
    return upsertReferencePrice(this.database, price);
  }
}

export async function readRecipeCostIngredients(
  shopId: string,
  recipeId: string,
  database: ReadDatabase,
) {
  return database
    .select({
      id: recipeIngredients.id,
      inventoryItemId: recipeIngredients.inventoryItemId,
      generalPriceId: recipeIngredients.generalPriceId,
      rawName: recipeIngredients.rawName,
      rawSrcUnit: recipeIngredients.rawSrcUnit,
      rawMaterialName: recipeIngredients.rawMaterialName,
      baseUnit: recipeIngredients.baseUnit,
      baseUnitAmount: recipeIngredients.baseUnitAmount,
      quantity: recipeIngredients.quantity,
      name: sql<string>`coalesce(${inventoryItems.name}, ${generalPrices.rawName})`,
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: recipeIngredientUnitCost,
    })
    .from(recipeIngredients)
    .leftJoin(
      inventoryItems,
      and(eq(inventoryItems.id, recipeIngredients.inventoryItemId), eq(inventoryItems.shopId, shopId)),
    )
    .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
    .where(
      and(
        eq(recipeIngredients.shopId, shopId),
        eq(recipeIngredients.recipeId, recipeId),
      ),
    )
    .orderBy(asc(recipeIngredients.id));
}

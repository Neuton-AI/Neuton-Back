import { and, asc, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { db, type Database } from '../../db/client.js';
import { categories, recipes, mediaUploads, recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import type { Category, InventoryItem, Recipe } from '../../db/schema/catalog.js';
import { notFound } from '../../lib/errors.js';
import { assertCatalogLinks } from '../../lib/catalogLinks.js';
import { quantity } from '../../lib/money.js';
import type { CategoryDto, CreateRecipeInput, InventoryDto, InventoryQuery, RecipeDto, RecipeQuery, RecipeSourceDto } from './contracts.js';

export type CatalogReadDatabase = Pick<Database, 'select'>;
export type CatalogTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type CatalogDatabase = Database | CatalogTransaction;
export const CATALOG_DATABASE = Symbol('CATALOG_DATABASE');

function mapCategory(category: Category): CategoryDto {
  return {
    id: category.id, shopId: category.shopId, name: category.name,
    createdAt: category.createdAt.toISOString(),
  };
}

function mapInventory(item: InventoryItem): Omit<InventoryDto, 'isLowStock'> {
  return {
    id: item.id, shopId: item.shopId, categoryId: item.categoryId,
    name: item.name, rawMaterialName: item.rawMaterialName, sku: item.sku,
    imageUrl: item.imageUrl, unit: item.unit, baseUnit: item.baseUnit,
    baseUnitAmount: item.baseUnitAmount, baseUnitCost: item.baseUnitCost,
    baseUnitAverageCost: item.baseUnitAverageCost, currentQuantity: item.currentQuantity,
    reorderLevel: item.reorderLevel, lastUnitCost: item.lastUnitCost,
    averageUnitCost: item.averageUnitCost, isActive: item.isActive,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
  };
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
export class CatalogPersistence {
  constructor(@Inject(CATALOG_DATABASE) readonly database: CatalogDatabase = db) {}

  async listCategories(shopId: string): Promise<CategoryDto[]> {
    const rows = await this.database.select().from(categories)
      .where(eq(categories.shopId, shopId)).orderBy(asc(categories.name));
    return rows.map(mapCategory);
  }

  async createCategory(shopId: string, name: string): Promise<CategoryDto> {
    const [category] = await this.database.insert(categories).values({ shopId, name }).returning();
    if (!category) throw new Error('Category insert returned no row');
    return mapCategory(category);
  }

  async createRecipe(shopId: string, input: CreateRecipeInput): Promise<RecipeDto> {
    return this.database.transaction(async tx => {
      await assertCatalogLinks(tx, shopId, input);
      const [recipe] = await tx.insert(recipes).values({
        shopId, name: input.name, description: input.description ?? null,
        imageUrl: input.imageUrl ?? null, categoryId: input.categoryId ?? null,
        prepTimeMinutes: input.prepTimeMinutes, yieldQuantity: quantity(input.yieldQuantity),
        yieldUnit: input.yieldUnit, targetMarginPct: input.targetMarginPct?.toFixed(2) ?? null,
        allergens: input.allergens, steps: input.steps ?? [], status: 'pending',
      }).returning();
      if (!recipe) throw new Error('Recipe insert returned no row');
      await tx.insert(recipeIngredients).values(input.ingredients.map(ingredient => ({
        shopId, recipeId: recipe.id, inventoryItemId: ingredient.inventoryItemId ?? null,
        generalPriceId: ingredient.generalPriceId ?? null, rawName: ingredient.rawName,
        rawMaterialName: ingredient.rawMaterialName?.trim() || ingredient.rawName,
        quantity: quantity(ingredient.quantity), rawSrcUnit: ingredient.rawSrcUnit,
        baseUnit: ingredient.baseUnit ?? null, baseUnitAmount: ingredient.baseUnitAmount?.toFixed(3) ?? null,
      })));
      return mapRecipe(recipe);
    });
  }

  async listInventory(shopId: string, query: InventoryQuery): Promise<Omit<InventoryDto, 'isLowStock'>[]> {
    const conditions = [eq(inventoryItems.shopId, shopId)];
    if (!query.includeInactive) conditions.push(eq(inventoryItems.isActive, true));
    if (query.search) conditions.push(sql`${inventoryItems.name} ilike ${`%${query.search}%`}`);
    if (query.lowStockOnly) conditions.push(
      sql`${inventoryItems.reorderLevel} is not null and ${inventoryItems.currentQuantity} <= ${inventoryItems.reorderLevel}`,
    );
    const rows = await this.database.select().from(inventoryItems)
      .where(and(...conditions)).orderBy(asc(inventoryItems.name));
    return rows.map(mapInventory);
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
    }));
  }
}

export async function readRecipeCostIngredients(
  shopId: string,
  recipeId: string,
  database: CatalogReadDatabase = db,
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

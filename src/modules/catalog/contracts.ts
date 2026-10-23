import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';

export const createCategorySchema = z.object({ name: htmlFree(z.string().trim().min(1).max(80)) });
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const inventoryQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  lowStockOnly: z.coerce.boolean().default(false),
  includeInactive: z.coerce.boolean().default(false),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;
export const recipeQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
  includeUnverified: z.coerce.boolean().default(false),
});
export const recipeIdSchema = z.object({ id: z.string().uuid() });
export type RecipeQuery = z.infer<typeof recipeQuerySchema>;

export interface CategoryDto {
  id: string;
  shopId: string;
  name: string;
  createdAt: string;
}

export interface InventoryDto {
  id: string;
  shopId: string;
  categoryId: string | null;
  name: string;
  rawMaterialName: string;
  sku: string | null;
  imageUrl: string | null;
  unit: string;
  baseUnit: string;
  baseUnitAmount: string;
  baseUnitCost: string;
  baseUnitAverageCost: string;
  currentQuantity: string;
  reorderLevel: string | null;
  lastUnitCost: string | null;
  averageUnitCost: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  isLowStock: boolean;
}

/** Costing only depends on these recipe values, not on a database row. */
export interface RecipeCostingInput {
  id: string;
  prepTimeMinutes: number;
  yieldQuantity: string;
  targetMarginPct: string | null;
}

export interface RecipeDto extends RecipeCostingInput {
  shopId: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  yieldUnit: string;
  allergens: string[] | null;
  steps: { stepNumber: number; instruction: string }[];
  isActive: boolean;
  status: string;
  storagePath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeSourceDto {
  sourceId: string;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  byteSize: number;
}

export interface CostedRecipeDto extends RecipeDto {
  costing: RecipeCostingDto;
}

export interface RecipeDetailDto extends CostedRecipeDto {
  sources: RecipeSourceDto[];
}

export interface OrderableRecipeDto {
  id: string;
  name: string;
  imageUrl: string | null;
  yieldQuantity: string;
  yieldUnit: string;
  costComplete: true;
  unitCost: number | null;
  retailPrice: number | null;
}

export interface RecipeIngredientCostDto {
  id: string;
  name: string;
  quantity: number;
  rawSrcUnit: string;
  rawMaterialName: string;
  baseUnit: string | null;
  baseUnitAmount: string | null;
  averageUnitCost: number | null;
  lineCost: number | null;
  currentQuantity: number;
  inventoryItemId: string | null;
  generalPriceId: string | null;
  rawName: string;
  linked: boolean;
}

export interface RecipeCostingDto {
  costComplete: boolean;
  unresolvedCount: number;
  unitCost: number | null;
  ingredientsCost: number;
  laborCost: number;
  batchCost: number | null;
  retailPrice: number | null;
  /** Preserve the existing incomplete-result representation. */
  appliedMarginPercent: number | '0.00';
  yieldQuantity: number;
  inStock: boolean;
  linkedCount: number;
  totalCount: number;
  ingredients: RecipeIngredientCostDto[];
}

export const recipeIngredientSchema = z.object({
  inventoryItemId: z.string().uuid().nullable().optional(),
  generalPriceId: z.string().uuid().nullable().optional(),
  rawName: htmlFree(z.string().trim().min(1).max(160)),
  rawMaterialName: htmlFree(z.string().trim().min(1).max(160)).optional(),
  quantity: z.coerce.number().positive(),
  rawSrcUnit: htmlFree(z.string().trim().min(1).max(24)),
  baseUnit: z.enum(['g', 'ml', 'each']).nullable().optional(),
  baseUnitAmount: z.number().finite().positive().max(999999999999.999).nullable().optional(),
}).refine((ingredient) => !(ingredient.inventoryItemId && ingredient.generalPriceId), 'Choose one ingredient price source');

export const recipeSchema = z.object({
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

export const recipePatchSchema = recipeSchema.partial();

export type CreateRecipeInput = z.infer<typeof recipeSchema>;

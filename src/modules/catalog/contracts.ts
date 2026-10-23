import { z } from 'zod';

export const inventoryQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  lowStockOnly: z.coerce.boolean().default(false),
  includeInactive: z.coerce.boolean().default(false),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

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

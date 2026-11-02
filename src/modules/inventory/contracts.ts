import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';

const queryBoolean = z
  .union([
    z.boolean(),
    z.enum(['true', 'false']).transform((value) => value === 'true'),
  ])
  .default(false);
export const inventoryQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    lowStockOnly: queryBoolean,
    includeInactive: queryBoolean,
  })
  .strict();
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

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

export const inventorySchema = z.object({
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

export const inventoryPatchSchema = inventorySchema.partial();

export type InventoryInput = z.infer<typeof inventorySchema>;
export type InventoryPatchInput = z.infer<typeof inventoryPatchSchema>;
export const inventoryIdSchema = z.object({ id: z.string().uuid() });

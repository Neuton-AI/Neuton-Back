import type { InventoryItem } from '../../src/db/schema/catalog.js';
export function inventoryRow(
  overrides: Partial<InventoryItem> = {},
): InventoryItem {
  return {
    id: '88888888-8888-8888-8888-888888888888',
    shopId: '22222222-2222-2222-2222-222222222222',
    categoryId: null,
    name: 'Product',
    rawMaterialName: 'product',
    sku: null,
    imageUrl: null,
    unit: 'g',
    baseUnit: 'g',
    baseUnitAmount: '1.000',
    baseUnitCost: '0.000000',
    baseUnitAverageCost: '0.000000',
    currentQuantity: '0.000',
    reorderLevel: null,
    lastUnitCost: null,
    averageUnitCost: null,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

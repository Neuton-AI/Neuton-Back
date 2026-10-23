import type { Recipe } from '../../src/db/schema/catalog.js';

/** Complete persisted row for tests exercising the public recipe mapper. */
export function recipeRow(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: '66666666-6666-6666-6666-666666666666',
    shopId: '22222222-2222-2222-2222-222222222222',
    categoryId: null, name: 'Recipe', description: null, imageUrl: null,
    prepTimeMinutes: 0, yieldQuantity: '1.000', yieldUnit: 'portion', targetMarginPct: null,
    allergens: [], steps: [], isActive: true, status: 'unverified',
    storagePath: null, errorMessage: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

import { AppError } from '../../lib/errors.js';
import type { CreateOrderInput } from './contracts.js';

export type OrderReviewState =
  | { recipeId: string; reason: 'NOT_FOUND' | 'INACTIVE' | 'UNVERIFIED' }
  | { recipeId: string; reason: null; name: string; unitPrice: string; costComplete: boolean };

/** Validate the complete submitted set before any number or order is written. */
export function reviewOrder(body: CreateOrderInput, states: readonly OrderReviewState[]): void {
  const confirmed = new Set(body.confirmedUnavailableRecipeIds ?? []);
  const unavailable = states.flatMap(state => state.reason === null ? [] : [state]);
  const currentItems = states.flatMap(state => {
    if (state.reason !== null) return [];
    return [{ recipeId: state.recipeId, name: state.name.slice(0, 160), unitPrice: state.unitPrice, costComplete: state.costComplete }];
  });
  if (currentItems.length === 0) {
    throw new AppError(409, 'NO_AVAILABLE_ITEMS', 'No selected items are currently available.');
  }
  const priceChanges: Array<{ recipeId: string; name: string; expectedUnitPrice: string; currentUnitPrice: string }> = [];
  for (const item of body.items) {
    const current = currentItems.find(state => state.recipeId === item.recipeId);
    if (current && item.expectedUnitPrice !== undefined && item.expectedUnitPrice !== current.unitPrice) {
      priceChanges.push({ recipeId: item.recipeId, name: current.name,
        expectedUnitPrice: item.expectedUnitPrice, currentUnitPrice: current.unitPrice });
    }
  }
  const reasons: Array<'PRICE_CHANGED' | 'AVAILABILITY_CHANGED'> = [];
  if (priceChanges.length > 0) {
    reasons.push('PRICE_CHANGED');
  }
  if (unavailable.some(state => !confirmed.has(state.recipeId)) || currentItems.some(state => confirmed.has(state.recipeId))) {
    reasons.push('AVAILABILITY_CHANGED');
  }
  if (reasons.length > 0) {
    throw new AppError(409, 'ORDER_REVIEW_REQUIRED', 'Review the updated order before saving.', {
      reasons, unavailable, priceChanges, currentItems,
    });
  }
}

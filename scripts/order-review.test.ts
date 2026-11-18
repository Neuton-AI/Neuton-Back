import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewOrder, type OrderReviewState } from '../src/modules/orders/order-review.js';
import type { CreateOrderInput } from '../src/modules/orders/contracts.js';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const input: CreateOrderInput = { customerName: 'Dana', destinationAddress: 'Market Street', deliveryDistanceKm: 0,
  items: [{ recipeId: first, quantity: 1, expectedUnitPrice: '2.60' }, { recipeId: second, quantity: 1, expectedUnitPrice: '0.00' }] };
const available: OrderReviewState = { recipeId: first, reason: null, name: 'First recipe', unitPrice: '2.60', costComplete: true };
const partial: OrderReviewState = { recipeId: second, reason: null, name: 'Partial recipe', unitPrice: '0.00', costComplete: false };
function errorOf(body: CreateOrderInput, states: OrderReviewState[]) {
  try { reviewOrder(body, states); } catch (error) { return error as { statusCode: number; code: string; details: any }; }
  throw new Error('Expected review failure');
}

test('matching complete and zero partial prices need no review', () => {
  assert.doesNotThrow(() => reviewOrder(input, [available, partial]));
});
test('price and availability conflicts are returned together with authoritative current items', () => {
  const error = errorOf(input, [{ ...available, unitPrice: '3.00' }, { recipeId: second, reason: 'INACTIVE' }]);
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, 'ORDER_REVIEW_REQUIRED');
  assert.deepEqual(error.details.reasons.sort(), ['AVAILABILITY_CHANGED', 'PRICE_CHANGED']);
  assert.deepEqual(error.details.unavailable, [{ recipeId: second, reason: 'INACTIVE' }]);
  assert.deepEqual(error.details.priceChanges, [{ recipeId: first, name: 'First recipe', expectedUnitPrice: '2.60', currentUnitPrice: '3.00' }]);
  assert.deepEqual(error.details.currentItems, [{ recipeId: first, name: 'First recipe', unitPrice: '3.00', costComplete: true }]);
});
test('confirmed unavailable lines are excluded only while they remain unavailable', () => {
  const body = { ...input, confirmedUnavailableRecipeIds: [second] };
  assert.doesNotThrow(() => reviewOrder(body, [available, { recipeId: second, reason: 'NOT_FOUND' }]));
  const error = errorOf(body, [available, partial]);
  assert.deepEqual(error.details.reasons, ['AVAILABILITY_CHANGED']);
  assert.equal(error.details.currentItems.length, 2);
});
test('every unavailable selection fails even with confirmation, preventing fee-only orders', () => {
  const error = errorOf({ ...input, confirmedUnavailableRecipeIds: [first, second] }, [
    { recipeId: first, reason: 'NOT_FOUND' }, { recipeId: second, reason: 'UNVERIFIED' },
  ]);
  assert.equal(error.code, 'NO_AVAILABLE_ITEMS');
});
test('legacy omitted expected prices retain compatibility without inventing review consent', () => {
  const body = { ...input, items: [{ recipeId: first, quantity: 1 }] };
  assert.doesNotThrow(() => reviewOrder(body, [available]));
});

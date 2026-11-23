import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelOrderSchema, createOrderSchema } from '../src/modules/orders/contracts.js';

const recipeId = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';
const input = { customerName: '  Dana  ', destinationAddress: '  Market Street  ', deliveryDate: '2026-11-20',
  deliveryFee: '0.00', items: [{ recipeId, quantity: 1, expectedUnitPrice: '2.60' }], confirmedUnavailableRecipeIds: [recipeId] };

test('review-aware create normalizes required text and retains expected prices and exact exclusions', () => {
  const parsed = createOrderSchema.parse(input);
  assert.equal(parsed.customerName, 'Dana');
  assert.equal(parsed.destinationAddress, 'Market Street');
  assert.equal(parsed.deliveryFee, 0);
  assert.equal(parsed.items[0]?.expectedUnitPrice, '2.60');
  assert.deepEqual(parsed.confirmedUnavailableRecipeIds, [recipeId]);
});

test('review-aware create bounds prices, lines and unique exclusion subsets', () => {
  const invalid = [
    { customerName: undefined }, { customerName: '' }, { customerName: '  ' }, { customerName: null },
    { destinationAddress: undefined }, { destinationAddress: '  ' }, { destinationAddress: null },
    { confirmedUnavailableRecipeIds: [recipeId, recipeId] }, { confirmedUnavailableRecipeIds: [otherId] },
    { confirmedUnavailableRecipeIds: ['invalid'] },
    { items: Array.from({ length: 101 }, () => input.items[0]) },
  ];
  for (const override of invalid) {
    assert.equal(createOrderSchema.safeParse({ ...input, ...override }).success, false, JSON.stringify(override));
  }
  for (const expectedUnitPrice of ['2.6', '-1.00', '1e2', '1.001', '100000000.00', '', null, 2.6]) {
    assert.equal(createOrderSchema.safeParse({ ...input, items: [{ recipeId, quantity: 1, expectedUnitPrice }] }).success, false);
  }
  assert.equal(createOrderSchema.safeParse({ ...input, items: [{ ...input.items[0], unitPrice: 0 }] }).success, false,
    'an expected price must never be combined with an override');
});

test('legacy omission keeps unknown date and no review consent while requiring customer and address', () => {
  const parsed = createOrderSchema.parse({ customerName: 'Dana', destinationAddress: 'Market Street', items: [{ recipeId, quantity: 1 }] });
  assert.equal(parsed.deliveryDate, undefined);
  assert.equal(parsed.deliveryFee, undefined);
  assert.equal(parsed.confirmedUnavailableRecipeIds, undefined);
  assert.equal(parsed.items[0]?.expectedUnitPrice, undefined);
});

test('cancellation validates that each finished-stock selection refers to a distinct order line', () => {
  const orderItemId = 'abcdef01-1111-4111-8111-111111111111';
  const selection = { orderItemId, quantity: 1 };
  const distinct = { orderItemId: otherId, quantity: 2 };

  assert.deepEqual(cancelOrderSchema.parse({ madeItems: true, stockItems: [selection, distinct] }).stockItems, [selection, distinct]);
  assert.deepEqual(cancelOrderSchema.parse({ madeItems: true, stockItems: [] }).stockItems, []);

  for (const duplicateId of [orderItemId, orderItemId.toUpperCase()]) {
    const input = { madeItems: true, stockItems: [selection, { orderItemId: duplicateId, quantity: 2 }] };
    assert.throws(() => cancelOrderSchema.parse(input), /Select each order line only once/);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWeightedAverage,
  average,
  calculateDeliveryFee,
  calculateOrderTotals,
  calculateRetailPrice,
  calculateUnitCost,
  checkBatchStock,
  median,
} from '../src/lib/pricing.js';

test('unit cost: materials + labor, divided by yield', () => {
  // 2kg flour @ 3.00 + 500g sugar @ 2.00/kg = 7.00 materials
  // 30 min @ 12.00/hr = 6.00 labor -> 13.00 batch -> 26.00 per portion (yield 0.5)
  const result = calculateUnitCost({
    ingredients: [
      { quantity: 2, averageUnitCost: 3 },
      { quantity: 0.5, averageUnitCost: 2 },
    ],
    prepTimeMinutes: 30,
    hourlyLaborCost: 12,
    yieldQuantity: 0.5,
  });

  assert.equal(result.ingredientsCost, 7);
  assert.equal(result.laborCost, 6);
  assert.equal(result.batchCost, 13);
  assert.equal(result.unitCost, 26);
});

test('unit cost: accepts decimal strings from numeric columns', () => {
  const result = calculateUnitCost({
    ingredients: [{ quantity: '1.500', averageUnitCost: '2.2500' }],
    prepTimeMinutes: 0,
    hourlyLaborCost: null,
    yieldQuantity: '1.000',
  });
  assert.equal(result.ingredientsCost, 3.375);
  assert.equal(result.laborCost, 0);
  assert.equal(result.unitCost, 3.375);
});

test('unit cost: zero yield does not produce Infinity or NaN', () => {
  const result = calculateUnitCost({
    ingredients: [{ quantity: 10, averageUnitCost: 1 }],
    prepTimeMinutes: 0,
    hourlyLaborCost: 0,
    yieldQuantity: 0,
  });
  assert.ok(Number.isFinite(result.unitCost), `unitCost was ${result.unitCost}`);
  assert.equal(result.unitCost, 10_000_000);
});

test('retail price: recipe margin overrides shop margin', () => {
  assert.equal(calculateRetailPrice(100, 30, null).retailPrice, 130);
  assert.equal(calculateRetailPrice(100, 30, 50).retailPrice, 150);
  assert.equal(calculateRetailPrice(100, 30, 50).appliedMarginPercent, 50);
  // Fallback when both are unset: no markup rather than NaN.
  assert.equal(calculateRetailPrice(100, null, null).retailPrice, 100);
});

test('delivery fee: base + per-km, negative distance clamped', () => {
  assert.equal(calculateDeliveryFee(3, 2, 1.5), 6.5);
  assert.equal(calculateDeliveryFee(-5, 2, 1.5), 2);
});

test('weighted average: first purchase sets the average to that unit price', () => {
  const result = applyWeightedAverage(
    { currentQuantity: 0, averageUnitCost: '0.0000' },
    { quantity: 10, unitPrice: 4 },
  );
  assert.equal(result.currentQuantity, 10);
  assert.equal(result.averageUnitCost, 4);
  assert.equal(result.lastUnitCost, 4);
});

test('weighted average: blends old and new stock proportionally', () => {
  // 10 @ 4.00 then 10 @ 6.00 -> 20 @ 5.00
  const result = applyWeightedAverage(
    { currentQuantity: 10, averageUnitCost: 4 },
    { quantity: 10, unitPrice: 6 },
  );
  assert.equal(result.currentQuantity, 20);
  assert.equal(result.averageUnitCost, 5);
});

test('weighted average: a larger cheap purchase dilutes the average', () => {
  // 2 @ 10.00 + 18 @ 1.00 -> 20 @ 1.90
  const result = applyWeightedAverage(
    { currentQuantity: 2, averageUnitCost: 10 },
    { quantity: 18, unitPrice: 1 },
  );
  assert.equal(result.averageUnitCost, 1.9);
});

test('weighted average: returns the old average instead of dividing by zero', () => {
  const result = applyWeightedAverage(
    { currentQuantity: 0, averageUnitCost: 7.5 },
    { quantity: 0, unitPrice: 3 },
  );
  assert.equal(result.currentQuantity, 0);
  assert.equal(result.averageUnitCost, 7.5);
});

test('stock check: in stock, short, and batch ceiling', () => {
  assert.deepEqual(checkBatchStock({ requiredQuantity: 4, currentQuantity: 10 }), {
    inStock: true,
    batchesAvailable: 2.5,
    shortfall: 0,
  });

  const short = checkBatchStock({ requiredQuantity: 10, currentQuantity: 4 });
  assert.equal(short.inStock, false);
  assert.equal(short.shortfall, 6);

  assert.deepEqual(checkBatchStock({ requiredQuantity: 0, currentQuantity: 0 }), {
    inStock: true,
    batchesAvailable: 0,
    shortfall: 0,
  });
});

test('order totals: profit is billed minus delivery minus production cost', () => {
  const totals = calculateOrderTotals({
    items: [
      { quantity: 10, unitCost: 2, unitPrice: 5 },
      { quantity: 5, unitCost: 4, unitPrice: 9 },
    ],
    deliveryFee: 7.5,
  });

  assert.equal(totals.totalCost, 40); // 10x2 + 5x4
  assert.equal(totals.totalAmount, 102.5); // 10x5 + 5x9 + 7.5
  assert.equal(totals.deliveryFee, 7.5);
  assert.equal(totals.netProfit, 55); // 102.5 - 7.5 - 40
  assert.equal(totals.profitMarginPercent, 53.66);
});

test('order totals: an empty order reports zero margin rather than NaN', () => {
  const totals = calculateOrderTotals({ items: [], deliveryFee: 5 });
  assert.equal(totals.totalAmount, 5);
  assert.equal(totals.netProfit, 0);
  assert.equal(totals.profitMarginPercent, 0);
});

test('median and average handle empty and even-length input', () => {
  assert.equal(median([]), 0);
  assert.equal(average([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(average([1, 2, 3, 4]), 2.5);
});
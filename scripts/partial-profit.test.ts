import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateOrderTotals } from '../src/lib/pricing.js';

test('partial lines retain revenue and known cost while contributing exactly zero profit', () => {
  const items = [{ quantity: 3, unitCost: 0.3333, unitPrice: 0.33, costComplete: false }];
  assert.deepEqual(calculateOrderTotals({ items, deliveryFee: 4 }), {
    totalAmount: 4.99, totalCost: 1, deliveryFee: 4, netProfit: 0, profitMarginPercent: 0,
  });
});

test('mixed orders keep complete-line profit at its existing calculation precision', () => {
  const items = [
    { quantity: 3, unitCost: 1.2345, unitPrice: 2, costComplete: true },
    { quantity: 3, unitCost: 0.3333, unitPrice: 0.33, costComplete: false },
    { quantity: 2, unitCost: 0, unitPrice: 0, costComplete: false },
  ];
  const totals = calculateOrderTotals({ items, deliveryFee: 1 });
  assert.equal(totals.totalAmount, 7.99);
  assert.equal(totals.totalCost, 4.7);
  assert.equal(totals.netProfit, 2.3);
});

test('complete and unknown legacy costing keep their previous accounting', () => {
  const legacy = calculateOrderTotals({ items: [{ quantity: 3, unitCost: 1.2345, unitPrice: 2 }], deliveryFee: 1 });
  const complete = calculateOrderTotals({ items: [{ quantity: 3, unitCost: 1.2345, unitPrice: 2, costComplete: true }], deliveryFee: 1 });
  assert.deepEqual(complete, legacy);
  assert.equal(complete.netProfit, 2.3);
});

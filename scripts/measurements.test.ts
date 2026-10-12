import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMeasurement, parseNumber, parseMeasurementText, convertRequirement } from '../src/lib/measurements.js';
import { normalizePurchase } from '../src/lib/purchaseNormalization.js';
import { applyWeightedAverage } from '../src/lib/pricing.js';

test('fractions and invalid quantities survive parsing', () => {
  for (const value of [.25, '0.25', '1/4', '¼']) assert.equal(parseNumber(value), .25);
  for (const value of ['1 1/2', '1½']) assert.equal(parseNumber(value), 1.5);
  for (const value of ['1/0', 'unknown', '1garbage2', '', null]) assert.equal(parseNumber(value), null);
});
test('dimensions, Hebrew expression boundaries and measurement conventions', () => {
  assert.equal(normalizeMeasurement(1, 'ק״ג').measurement?.quantity, 1000);
  assert.equal(normalizeMeasurement(1, 'oz').measurement?.unit, 'g');
  assert.equal(normalizeMeasurement(1, 'fl oz').reason, 'ambiguous_unit');
  assert.equal(normalizeMeasurement(1, 'fl oz', 'us').measurement?.unit, 'ml');
  assert.equal(parseMeasurementText('קורנפלור 500 גרם')?.quantity, 500);
  assert.equal(parseMeasurementText('sugar'), null);
  assert.equal(normalizeMeasurement(null, 'g').reason, 'missing_quantity');
});
test('paid purchase normalization preserves package and weight bases', () => {
  const purchase = normalizePurchase({ rawName: 'קורנפלור 500 גרם', quantity: 2, unit: 'unit', unitPrice: 7, totalPrice: 14, currency: 'ILS' });
  assert.deepEqual(purchase.measurement, { quantity: 1000, unit: 'g' });
  assert.equal(purchase.rate, .014);
  assert.ok(Math.abs(purchase.rate! * 50 - .7) < 1e-10);
  assert.equal(normalizePurchase({ rawName: 'lemons', quantity: .925, unit: 'kg', unitPrice: 9.9, totalPrice: 9.16, currency: 'ILS' }).paidAmount, 9.16);
  assert.equal(normalizePurchase({ rawName: 'margarine', quantity: 8, unit: 'unit', unitPrice: 6.9, totalPrice: 55.2, currency: 'ILS' }).reason, 'missing_package_size');
  const multi = normalizePurchase({ rawName: 'butter', quantity: 2, unit: 'pack', unitPrice: 10, totalPrice: 20, packageQuantity: 250, packageUnit: 'g', packagesPerPurchase: 2, currency: 'ILS' });
  assert.equal(multi.measurement?.quantity, 1000);
});
test('baking powder profile is scoped, sourced and estimated', () => {
  const result = convertRequirement({ quantity: '1/4', unit: 'tsp', target: 'g', ingredient: 'baking powder', convention: 'us' });
  assert.equal(result.measurement?.quantity, 1);
  assert.equal(result.state, 'estimated');
  assert.ok(result.provenance.some(p => p.includes('kingarthur')));
  assert.equal(convertRequirement({ quantity: 1, unit: 'tsp', target: 'g', ingredient: 'mystery', convention: 'us' }).reason, 'missing_ingredient_conversion');
  assert.equal(convertRequirement({ quantity: 115, unit: 'g', target: 'g', ingredient: 'butter' }).state, 'ready');
});
test('mixed normalized purchases maintain quantity and value', () => {
  const first = normalizePurchase({ rawName: 'sugar', quantity: 1, unit: 'kg', unitPrice: 20, totalPrice: 20, currency: 'ILS' });
  const next = normalizePurchase({ rawName: 'sugar', quantity: 500, unit: 'g', unitPrice: .03, totalPrice: 15, currency: 'ILS' });
  const a = applyWeightedAverage({ currentQuantity: 0, averageUnitCost: 0 }, { quantity: first.measurement!.quantity, unitPrice: first.rate! });
  const b = applyWeightedAverage(a, { quantity: next.measurement!.quantity, unitPrice: next.rate! });
  assert.equal(b.currentQuantity, 1500);
  assert.ok(Math.abs(b.averageUnitCost * 1500 - 35) < 1e-6);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProductPrice } from '../src/lib/supermarket/productConversion.js';
import { priceResult } from './support/priceResult.js';

const product = priceResult({ UnitQty: 'kg', Quantity: '1', ItemPrice: '10', bIsWeighted: '0' });

test('package mass, volume and count use shared conversion ratios and exact normalized columns', () => {
  for (const [unit, quantity, base, amount, cost] of [
    ['kg', '1', 'g', '1000.000', '0.010000'],
    ['ק"ג', '1', 'g', '1000.000', '0.010000'],
    ['l', '0.5', 'ml', '500.000', '0.020000'],
    ['each', '5', 'each', '5.000', '2.000000'],
    ['dozen', '1', 'each', '12.000', '0.833333'],
  ]) {
    const normalized = normalizeProductPrice({ ...product, UnitQty: unit!, Quantity: quantity! }, 'flour');
    assert.deepEqual(normalized, {
      rawName: 'Milk', sku: '123', rawMaterialName: 'flour', rawSrcUnit: unit,
      srcUnit: unit === 'ק"ג' ? 'kg' : unit, baseUnit: base, baseUnitAmount: amount, baseUnitCost: cost,
    });
  }
});

test('weighted products price the declared measurement basis, not Quantity or comparison package size', () => {
  for (const [unit, amount, cost] of [
    ['kg', '1000.000', '0.010000'], ['1קילוגרם', '1000.000', '0.010000'],
    ['100 גרם', '100.000', '0.100000'],
  ]) {
    const normalized = normalizeProductPrice({ ...product, bIsWeighted: '1', Quantity: '0.25', UnitOfMeasure: unit! }, 'flour');
    assert.equal(normalized?.baseUnitAmount, amount);
    assert.equal(normalized?.baseUnitCost, cost);
    assert.equal(normalized?.rawSrcUnit, unit);
  }
});

test('missing, ambiguous, invalid and unrepresentable product data remain unresolved', () => {
  for (const invalid of [
    { Quantity: '' }, { Quantity: '0' }, { Quantity: '-1' }, { Quantity: '1foo' },
    { Quantity: '1e100' }, { Quantity: '0.00000001' }, { ItemPrice: '0' },
    { ItemPrice: '-10' }, { ItemPrice: 'NaN' }, { ItemPrice: 'Infinity' },
    { ItemPrice: '0.000000001' }, { ItemPrice: '100000000000000000' },
    { UnitQty: '' }, { UnitQty: 'kg / l' }, { UnitQty: 'bag' }, { UnitQty: 'מארז' },
    { bIsWeighted: 'unknown' }, { bIsWeighted: '1', UnitOfMeasure: '' },
    { bIsWeighted: '1', UnitOfMeasure: 'each' }, { ItemName: '' }, { ItemCode: '' },
  ]) assert.equal(normalizeProductPrice({ ...product, ...invalid }, 'flour'), null, JSON.stringify(invalid));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProductPrice } from '../src/lib/supermarket/productConversion.js';
import { priceResult } from './support/priceResult.js';

const product = priceResult({ unitQty: 'kg', quantity: '1', itemPrice: '10', bIsWeighted: '0' });

test('package mass, volume and count use shared conversion ratios and exact normalized columns', () => {
  for (const [unit, quantity, base, amount, cost] of [
    ['kg', '1', 'g', '1000.000', '0.010000'],
    ['ק"ג', '1', 'g', '1000.000', '0.010000'],
    ['l', '0.5', 'ml', '500.000', '0.020000'],
    ['each', '5', 'each', '5.000', '2.000000'],
    ['dozen', '1', 'each', '12.000', '0.833333'],
  ]) {
    const normalized = normalizeProductPrice({ ...product, unitQty: unit!, quantity: quantity! }, 'flour');
    assert.deepEqual(normalized, {
      rawName: 'Milk', sku: '123', rawMaterialName: 'flour', rawSrcUnit: unit,
      srcUnit: unit === 'ק"ג' ? 'kg' : unit, baseUnit: base, baseUnitAmount: amount, baseUnitCost: cost,
    });
  }
});

test('unitOfMeasure and weighted flags never affect receipt-pipeline conversion', () => {
  const expected = normalizeProductPrice({ ...product, quantity: '0.25' }, 'flour');
  assert.equal(expected?.baseUnitAmount, '250.000');
  assert.equal(expected?.baseUnitCost, '0.040000');
  for (const unitOfMeasure of ['', 'kg', '100 גרם', 'invalid']) {
    for (const bIsWeighted of ['', '0', '1', 'unknown']) {
      assert.deepEqual(normalizeProductPrice({
        ...product, quantity: '0.25', unitOfMeasure, bIsWeighted,
      }, 'flour'), expected);
    }
  }
  const unreadable = { ...product };
  Object.defineProperty(unreadable, 'unitOfMeasure', { get() { throw new Error('must not read unitOfMeasure'); } });
  assert.equal(normalizeProductPrice(unreadable, 'flour')?.baseUnitAmount, '1000.000');
});

test('missing, unknown, invalid and unrepresentable product data remain unresolved', () => {
  for (const invalid of [
    { quantity: null }, { itemPrice: null }, { unitQty: null }, { itemName: null },
    { quantity: '' }, { quantity: '0' }, { quantity: '-1' }, { quantity: '1foo' },
    { quantity: '1e100' }, { quantity: '0.00000001' },
    { itemPrice: '-10' }, { itemPrice: 'NaN' }, { itemPrice: 'Infinity' },
    { itemPrice: '0.000000001' }, { itemPrice: '100000000000000000' },
    { unitQty: '' }, { unitQty: 'bag' },
    { itemName: '' }, { itemCode: '' },
  ]) assert.equal(normalizeProductPrice({ ...product, ...invalid }, 'flour'), null, JSON.stringify(invalid));
});

test('a free supermarket product preserves a valid zero base price', () => {
  assert.equal(normalizeProductPrice({ ...product, itemPrice: '0' }, 'flour')?.baseUnitCost, '0.000000');
});

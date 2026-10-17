import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { convertMeasurement, parseMeasurementQuantity } from '../src/lib/unitConversion.js';
import { convertRecipeToBaseUnits } from '../src/lib/recipeConversion.js';
import { parseRecipeExtraction } from '../src/lib/gemini.js';
import { convertSrcAmountToBase, setUnitsData } from '../src/lib/supermarket/conversion.js';
import type { ExtractedLineItem } from '../src/lib/gemini.js';
import type { PriceResult } from '../src/lib/supermarket/prices.js';

function receiptItem(overrides: Partial<ExtractedLineItem> = {}): ExtractedLineItem {
  return { rawName: 'Flour', rawMaterialName: 'Flour', rawSku: null, isSkuEnriched: true,
    quantity: 3, rawSrcUnit: 'kg', srcUnit: 'kg', srcUnitAmount: 0.2,
    baseUnit: 'g', baseUnitAmount: null, unitPrice: null, totalPrice: null, confidence: null, ...overrides };
}

test('recipe and receipt conversion share bilingual aliases and fractional quantities', () => {
  for (const [quantity, unit, base, expected] of [
    [0.2, 'kg', 'g', 200], [0.2, ' ק״ג ', 'g', 200], ['1/2', 'KG', 'g', 500],
    [0.5, 'l', 'ml', 500], ['½', 'ליטר', 'ml', 500], ['1 1/2', 'litres', 'ml', 1500],
    [2, 'יחידות', 'each', 2], [0.5, 'dozen', 'each', 6], [2, 'pieces', 'each', 2],
    [1000, 'מ״ג', 'g', 1], [1, 'oz', 'g', 28.3495], [1, 'lb', 'g', 453.592],
    [1, 'us cup', 'ml', 236.588], [1, 'us tbsp', 'ml', 14.7868], [1, 'us tsp', 'ml', 4.92892],
  ] as const) {
    assert.deepEqual(convertMeasurement(quantity, unit), { baseUnit: base, baseUnitAmount: expected, unresolvedReason: null });
    const item = receiptItem({ srcUnit: unit, srcUnitAmount: parseMeasurementQuantity(quantity), baseUnit: base });
    convertSrcAmountToBase(item);
    assert.equal(item.baseUnitAmount, expected);
    assert.equal(item.quantity, 3, 'package conversion must not multiply by purchased count');
  }
});

test('invalid quantities, packages and ambiguous household measures stay unresolved', () => {
  for (const quantity of [null, undefined, '', 0, -1, NaN, Infinity, '1/0', '2 cups', 'about 2', {}, '1-2']) {
    assert.equal(convertMeasurement(quantity, 'kg').unresolvedReason, 'invalid-quantity');
  }
  for (const unit of [null, '', 'pack', 'מארז', 'bag', 'cup', 'כוס', 'tbsp', 'כף', 'pinch', 'handful', 'kg/ml', '200 g']) {
    assert.equal(convertMeasurement(1, unit).unresolvedReason, 'unsupported-unit');
  }
  for (const [unit, target] of [['kg', 'ml'], ['ml', 'each'], ['each', 'g']] as const) {
    assert.deepEqual(convertMeasurement(1, unit, target), { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'incompatible-unit' });
  }
  assert.equal(convertMeasurement(Number.MAX_VALUE, 'kg').unresolvedReason, 'invalid-base-amount');
  const stale = receiptItem({ srcUnit: 'kg', baseUnit: 'ml', baseUnitAmount: 999 });
  convertSrcAmountToBase(stale);
  assert.equal(stale.baseUnitAmount, null);
  assert.equal(stale.baseUnit, null);
});

test('full recipe conversion preserves original fields, steps and links without mutating extraction', () => {
  const recipe = { ...parseRecipeExtraction({ name: 'Bread', steps: [{ stepNumber: 1, instruction: 'Mix' }],
    ingredients: [
      { rawName: 'flour', quantity: '1/5', rawSrcUnit: 'kg' },
      { rawName: 'milk', quantity: '½', rawSrcUnit: 'l' },
      { rawName: 'eggs', quantity: '.5', rawSrcUnit: 'dozen' },
      { rawName: 'salt', quantity: null, rawSrcUnit: null },
      { rawName: 'sugar', quantity: 1, rawSrcUnit: 'cup' },
    ] }), id: 'recipe', inventoryItemId: 'preserved', packageSize: 1000 };
  const original = structuredClone(recipe);
  const converted = convertRecipeToBaseUnits(recipe);
  assert.deepEqual(recipe, original);
  assert.deepEqual(converted.ingredients.map((i) => [i.baseUnit, i.baseUnitAmount]), [
    ['g', 200], ['ml', 500], ['each', 6], [null, null], [null, null],
  ]);
  assert.deepEqual({ ...converted, ingredients: recipe.ingredients }, recipe);
  converted.ingredients.forEach((ingredient, index) => {
    assert.deepEqual({ ...ingredient, baseUnit: null, baseUnitAmount: null }, recipe.ingredients[index]);
  });
});

test('receipt package enrichment still converts package contents through the shared core', () => {
  for (const [unit, quantity, baseUnit, baseUnitAmount] of [
    ['קילוגרם', '0.5', 'g', 500], ['ק״ג,', '1/2', 'g', 500], ['ליטר', '1', 'ml', 1000], ['יחידה', '6', 'each', 6],
  ] as const) {
    const item = receiptItem();
    const product = { UnitQty: unit, Quantity: quantity } as PriceResult;
    const result = setUnitsData([{ item, itemEnrichment: [product] }]);
    assert.equal(result[0]?.item.baseUnit, baseUnit);
    assert.equal(result[0]?.item.baseUnitAmount, baseUnitAmount);
    assert.equal(item.quantity, 3);
  }
});

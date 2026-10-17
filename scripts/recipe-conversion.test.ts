import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecipeExtraction } from '../src/lib/gemini.js';
import { convertRecipeToBaseUnits } from '../src/lib/recipeConversion.js';
import { convertSrcAmountToBase, getBaseAndCurrentUnit, setUnitsData } from '../src/lib/supermarket/conversion.js';
import type { ExtractedLineItem } from '../src/lib/gemini.js';
import { priceResult } from './support/priceResult.js';

function recipe(quantity: number | null, rawSrcUnit: string | null): RecipeExtraction {
  return {
    name: 'Bread', description: 'Original description', prepTimeMinutes: 30,
    yieldQuantity: 2, yieldUnit: 'loaves', allergens: ['gluten'],
    steps: [{ stepNumber: 1, instruction: 'Mix, then bake.' }],
    ingredients: [{ rawName: 'flour', rawMaterialName: 'flour', quantity, rawSrcUnit, baseUnit: null, baseUnitAmount: null }],
  };
}

const fixtures: [string, number, string, number][] = [
  ['mg', 500, 'g', 0.5], ['milligrams', 1000, 'g', 1], ['מיליגרם', 250, 'g', 0.25],
  ['kg', 0.2, 'g', 200], ['קילוגרם', 0.2, 'g', 200], ['KG.', 0.2, 'g', 200],
  ['kilograms', 0.2, 'g', 200], ['grams', 2, 'g', 2], ['גרם', 2, 'g', 2],
  ['l', 0.5, 'ml', 500], ['ליטר', 0.5, 'ml', 500], ['litres', 0.5, 'ml', 500],
  ['milliliters', 3, 'ml', 3], ['מיליליטר', 3, 'ml', 3],
  ['cup', 0.5, 'ml', 118.294], ['cups', 2, 'ml', 473.176],
  ['tbsp', 1, 'ml', 14.7868], ['Tablespoons', 2, 'ml', 29.5736],
  ['tsp', 1, 'ml', 4.92892], ['teaspoons', 2, 'ml', 9.85784],
  ['oz', 1, 'g', 28.3495], ['ounces', 2, 'g', 56.699],
  ['lb', 1, 'g', 453.592], ['pounds', 2, 'g', 907.184],
  ['piece', 2, 'each', 2], ['pcs', 2, 'each', 2], ['יחידות', 2, 'each', 2],
  ['dozen', 0.5, 'each', 6], ['each', 3, 'each', 3],
];

for (const [unit, quantity, baseUnit, amount] of fixtures) {
  test(`${quantity} ${unit}: recipe and receipt conversion agree`, () => {
    const source = recipe(quantity, unit);
    const before = structuredClone(source);
    const converted = convertRecipeToBaseUnits(source);
    assert.deepEqual(converted, { ...source, ingredients: [{ ...source.ingredients[0], baseUnit, baseUnitAmount: amount }] });
    assert.deepEqual(source, before);
    const found = getBaseAndCurrentUnit(unit);
    const receipt = convertSrcAmountToBase({ srcUnit: found.current, srcUnitAmount: quantity, baseUnit: found.base, baseUnitAmount: null as number | null });
    assert.equal(receipt.baseUnitAmount, amount);
  });
}

test('missing, invalid, package, compound and unsupported inputs remain unresolved', () => {
  const inputs: [number | null, string | null][] = [
    [null, 'kg'], [0, 'kg'], [-1, 'kg'], [NaN, 'kg'], [Infinity, 'kg'], [Number.MAX_VALUE, 'kg'],
    [1, null], [1, ''], [1, 'pinch'], [1, 'bag'], [1, 'מארז'],
    [1, 'kg/ml'], [1, 'kg-ml'], [1, 'מארז,'], [1, 'kg or l'], [1, 'heaped tbsp'], [1, '2 cups'], [1, 'cupboard'],
  ];
  for (const [quantity, unit] of inputs) {
    const input = recipe(quantity, unit);
    input.ingredients[0]!.baseUnit = 'g';
    input.ingredients[0]!.baseUnitAmount = 123;
    const result = convertRecipeToBaseUnits(input).ingredients[0]!;
    assert.equal(result.baseUnit, null, String(unit));
    assert.equal(result.baseUnitAmount, null, String(unit));
    assert.equal(result.quantity, quantity);
    assert.equal(result.rawSrcUnit, unit);
  }
});

test('receipt package conversion still uses package amount, recipe uses its own quantity', () => {
  const receipt: ExtractedLineItem = {
    rawName: 'Flour', rawMaterialName: 'flour', rawSku: null, isSkuEnriched: true,
    quantity: 3, rawSrcUnit: 'kg', srcUnit: 'kg', srcUnitAmount: null,
    baseUnit: null, baseUnitAmount: null, unitPrice: null, totalPrice: null, confidence: 1,
  };
  setUnitsData([{ item: receipt, itemEnrichment: [priceResult({ UnitQty: 'קילוגרם', Quantity: '2' })] }]);
  assert.equal(receipt.baseUnit, 'g');
  assert.equal(receipt.baseUnitAmount, 2000);
  assert.equal(convertRecipeToBaseUnits(recipe(0.2, 'kg')).ingredients[0]!.baseUnitAmount, 200);
});

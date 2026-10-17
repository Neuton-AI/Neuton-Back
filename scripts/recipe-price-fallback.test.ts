import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { linkRecipeFallbackPrices, normalizePriceName } from '../src/lib/recipePriceFallback.js';
import { costRecipe } from '../src/routes/catalog.js';
import type { Database } from '../src/db/client.js';
import type { recipes } from '../src/db/schema/index.js';
import { priceResult } from './support/priceResult.js';
import { FakeDb } from './support/fakeDb.js';

const product = priceResult();
const line = { id: 'line-1', rawName: ' Milk ', rawMaterialName: ' Milk ', inventoryItemId: null, generalPriceId: null };
const asDatabase = (db: FakeDb) => db as unknown as Database;

test('fallback links the best affordable scored product directly, with no inventory writes', async () => {
  const db = new FakeDb({
    'select:recipeIngredients': [[line]],
    'insert:generalPrices': [[{ id: 'price-1' }]],
  });
  const queries: string[] = [];
  await linkRecipeFallbackPrices(asDatabase(db), 'shop-1', 'recipe-1', async (query) => {
    queries.push(query);
    return [{ ...product, ItemPrice: '7' }, product, { ...product, ItemName: 'Chocolate milk', score: 9000, ItemPrice: '2' }];
  });
  assert.deepEqual(queries, ['milk']);
  const saved = db.onlyCallTo('insert', 'generalPrices').values as Record<string, unknown>;
  assert.equal(saved.baseUnitCost, null);
  assert.equal(saved.sku, '123');
  assert.equal(saved.rawMaterialName, 'milk');
  assert.deepEqual(db.onlyCallTo('update', 'recipeIngredients').set, { generalPriceId: 'price-1' });
  assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
});

test('fallback skips both existing link types and empty names on a retry', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[
    { ...line, inventoryItemId: 'inv-1' },
    { ...line, generalPriceId: 'price-1' },
    { ...line, rawName: ' ', rawMaterialName: ' ' },
  ]] });
  await linkRecipeFallbackPrices(asDatabase(db), 'shop-1', 'recipe-1', async () => {
    assert.fail('linked ingredients must not be searched');
  });
  assert.equal(db.callsTo('insert', 'generalPrices').length, 0);
});

test('missing, low-confidence, invalid and failed catalog searches leave lines unlinked', async () => {
  for (const search of [
    async () => [],
    async () => [{ ...product, score: 100 }],
    async () => [{ ...product, ItemPrice: 'NaN' }],
    async () => [{ ...product, ItemPrice: '-1' }],
    async () => { throw new Error('catalog unavailable'); },
  ]) {
    const db = new FakeDb({ 'select:recipeIngredients': [[line]] });
    await linkRecipeFallbackPrices(asDatabase(db), 'shop-1', 'recipe-1', search);
    assert.equal(db.callsTo('update', 'recipeIngredients').length, 0);
    assert.equal(db.callsTo('insert', 'generalPrices').length, 0);
  }
});

test('name normalization handles Hebrew quotes and repeated spaces', () => {
  assert.equal(normalizePriceName('  קג״ חלב  טרי '), 'קג חלב טרי');
});

test('mixed inventory and fallback prices count as fully costed without claiming fallback stock', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[
    { inventoryItemId: 'inv-1', generalPriceId: null, rawName: 'Flour', quantity: '2', baseUnitAmount: '2', rawSrcUnit: 'kg', averageUnitCost: '4', currentQuantity: '10' },
    { inventoryItemId: null, generalPriceId: 'price-1', rawName: 'Milk', quantity: '3', baseUnitAmount: '3', rawSrcUnit: 'unit', averageUnitCost: '6', currentQuantity: null },
  ]] });
  const recipe = { id: 'recipe-1', prepTimeMinutes: 0, yieldQuantity: '2', targetMarginPct: '30' } as typeof recipes.$inferSelect;
  const costing = await costRecipe('shop-1', recipe, '30', '0', asDatabase(db));
  assert.equal(costing.ingredientsCost, 26);
  assert.equal(costing.linkedCount, 2);
  assert.equal(costing.totalCount, 2);
  assert.equal(costing.ingredients[1]?.linked, true);
  assert.equal(costing.ingredients[1]?.generalPriceId, 'price-1');
  assert.equal(costing.ingredients[1]?.lineCost, 18);
  assert.equal(costing.inStock, false);
  assert.notEqual(costing.retailPrice, '0.0000');
  assert.deepEqual(db.onlyCallTo('select', 'recipeIngredients').joins, ['leftJoin', 'leftJoin']);
});

test('preserved links with unresolved base conversion cannot count as valid zero-cost matches', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[
    { inventoryItemId: null, generalPriceId: 'price-legacy', rawName: 'Milk', quantity: '1', rawSrcUnit: 'cup', baseUnitAmount: null, averageUnitCost: null, currentQuantity: null },
  ]] });
  const recipe = { id: 'recipe-1', prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: '30' } as typeof recipes.$inferSelect;
  const costing = await costRecipe('shop-1', recipe, '30', '0', asDatabase(db));
  assert.equal(costing.linkedCount, 0);
  assert.equal(costing.ingredients[0]?.linked, false);
  assert.equal(costing.ingredients[0]?.generalPriceId, 'price-legacy');
  assert.equal(costing.retailPrice, '0.0000');
  assert.equal(costing.inStock, false);
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRecipeFallbackPrices, persistRecipeFallbackPrices, selectFallbackProduct, normalizePriceName } from '../src/lib/recipePriceFallback.js';
import { costRecipe } from '../src/routes/catalog.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { recipeIngredientUnitCost } from '../src/lib/recipeCostQuery.js';
import type { Database } from '../src/db/client.js';
import { recipeIngredients, type recipes } from '../src/db/schema/index.js';
import { priceResult } from './support/priceResult.js';
import { FakeDb } from './support/fakeDb.js';

const product = priceResult({ UnitQty: 'l', Quantity: '1', bIsWeighted: '0' });
const line = { id: 'line-1', rawName: ' Milk ', rawMaterialName: ' Milk ', inventoryItemId: null, generalPriceId: null };
const asDatabase = (db: FakeDb) => db as unknown as Database;

async function linkRecipeFallbackPrices(db: Database, shopId: string, recipeId: string, search: typeof import('../src/lib/supermarket/prices.js').searchProduct) {
  // Read fixtures before preparing searches, then exercise the atomic persistence API.
  const fake = db as unknown as FakeDb;
  const ingredients = await db.select().from(recipeIngredients);
  fake.push('select', 'recipeIngredients', ingredients);
  const prepared = await prepareRecipeFallbackPrices(ingredients, search);
  await db.transaction(tx => persistRecipeFallbackPrices(tx, shopId, recipeId, prepared));
}

test('fallback selects the highest score without name or price ranking filters', async () => {
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
  assert.equal(saved.baseUnitCost, '0.002000');
  assert.equal(saved.baseUnitAmount, '1000.000');
  assert.equal(saved.rawName, 'Chocolate milk');
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

test('missing, invalid and failed catalog searches leave lines unlinked', async () => {
  for (const search of [
    async () => [],
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
  assert.equal(costing.retailPrice, null);
  assert.equal(costing.unitCost, null);
  assert.equal(costing.ingredients[0]?.lineCost, null);
  assert.equal(costing.inStock, false);
});

test('ties are stable across result order and low scores remain eligible', async () => {
  const a = { ...product, ItemCode: '001', score: 1 };
  const b = { ...product, ItemCode: '002', score: 1 };
  for (const results of [[b, a], [a, b]]) {
    assert.equal(selectFallbackProduct(results), a);
    const prepared = await prepareRecipeFallbackPrices([line], async () => results);
    assert.equal(prepared.get('milk')?.sku, '001');
  }
});

test('invalid highest-ranked product remains unresolved instead of picking the runner-up', async () => {
  for (const invalid of [{ Quantity: '' }, { ItemPrice: '' }, { UnitQty: 'bag' }, { ItemCode: '' }]) {
    const prepared = await prepareRecipeFallbackPrices([line], async () => [product, { ...product, ...invalid, score: 9999 }]);
    assert.equal(prepared.get('milk'), null);
  }
});

test('repeated material names share one search, upsert and saved ID in a short transaction', async () => {
  const db = new FakeDb({
    'select:recipeIngredients': [[line, { ...line, id: 'line-2', rawMaterialName: 'milk' }]],
    'insert:generalPrices': [[{ id: 'price-1' }]],
  });
  let searches = 0;
  await linkRecipeFallbackPrices(asDatabase(db), 'shop-1', 'recipe-1', async () => {
    assert.equal(db.transactionCount, 0);
    searches++;
    return [product];
  });
  assert.equal(searches, 1);
  assert.equal(db.onlyCallTo('insert', 'generalPrices').inTransaction, true);
  assert.deepEqual(db.callsTo('update', 'recipeIngredients').map(call => call.set), [
    { generalPriceId: 'price-1' }, { generalPriceId: 'price-1' },
  ]);
});

test('catalog search keeps invalid-price winners available for explicit unresolved handling', async () => {
  const { createProductSearch } = await import('../src/lib/supermarket/prices.js');
  const search = createProductSearch(async () => [
    { ...product, ItemName: 'Milk', ItemPrice: '' },
    { ...product, ItemCode: '456', ItemName: 'Milk fresh' },
  ]);
  const matches = await prepareRecipeFallbackPrices([line], search);
  assert.equal(matches.get('milk'), null);
});

test('recipe APIs use converted line cost, labor and yield, including valid free ingredients', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[
    { inventoryItemId: 'inv-1', generalPriceId: null, rawName: 'Flour', quantity: '0.2', baseUnitAmount: '200', baseUnit: 'g', rawSrcUnit: 'kg', averageUnitCost: '0.01', currentQuantity: '10' },
    { inventoryItemId: null, generalPriceId: 'price-free', rawName: 'Water', quantity: '250', baseUnitAmount: '250', baseUnit: 'ml', rawSrcUnit: 'ml', averageUnitCost: '0', currentQuantity: null },
  ]] });
  const recipe = { id: 'recipe-1', prepTimeMinutes: 30, yieldQuantity: '4', targetMarginPct: '30' } as typeof recipes.$inferSelect;
  const costing = await costRecipe('shop-1', recipe, '30', '20', asDatabase(db));
  assert.equal(costing.costComplete, true);
  assert.equal(costing.ingredients[0]?.lineCost, 2);
  assert.equal(costing.ingredients[1]?.lineCost, 0);
  assert.equal(costing.ingredients[1]?.linked, true);
  assert.equal(costing.batchCost, 12);
  assert.equal(costing.unitCost, 3);
  assert.equal(costing.retailPrice, 3.9);
});

test('shared price query requires matching canonical units and uses only base prices', () => {
  const { sql } = new PgDialect().sqlToQuery(recipeIngredientUnitCost);
  assert.match(sql, /"recipe_ingredients"\."base_unit" in \('g', 'ml', 'each'\)/);
  assert.match(sql, /"recipe_ingredients"\."base_unit" = "inventory_items"\."base_unit"/);
  assert.match(sql, /"recipe_ingredients"\."base_unit" = "general_prices"\."base_unit"/);
  assert.match(sql, /"inventory_items"\."base_unit_average_cost"/);
  assert.match(sql, /"general_prices"\."base_unit_cost"/);
  assert.doesNotMatch(sql, /"average_unit_cost"|"price_ils"/);
});

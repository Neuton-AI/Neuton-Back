import './support/testEnv.js';
import { recipeRow } from './support/recipeFixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { priceResult } from './support/priceResult.js';
import type { searchProduct } from '../src/lib/supermarket/prices.js';
import { costRecipe } from '../src/modules/catalog/costing.js';
import type { Database } from '../src/db/client.js';
import type { recipes } from '../src/db/schema/index.js';
import { prepareBarcodePrice } from '../src/lib/recipeBarcodePrice.js';

const ID = '66666666-6666-6666-6666-666666666666';
const PRICE_ID = '77777777-7777-7777-7777-777777777777';
const INVENTORY_ID = '88888888-8888-8888-8888-888888888888';
const BARCODE = '7290000000001';
const ingredient = { rawName: 'Original recipe milk', rawMaterialName: 'Milk', quantity: 0.25, rawSrcUnit: 'l' };
const product = priceResult({ ItemCode: BARCODE, ItemName: 'Original supermarket milk', UnitQty: 'l', Quantity: '1', ItemPrice: '6' });

test('zero-padded GTIN-14 resolves its exact EAN-13 catalog equivalent', async () => {
  const scanned = '07290000453897';
  const canonical = '7290000453897';
  const queries: string[] = [];
  const result = await prepareBarcodePrice({ ...ingredient, barcode: scanned }, async (query) => {
    queries.push(query);
    return query === scanned ? [] : [
      { ...product, ItemCode: `${canonical}9`, score: 99999 },
      { ...product, ItemCode: canonical },
    ];
  });
  assert.deepEqual(queries, [scanned, canonical]);
  assert.equal(result.price.sku, canonical);
  assert.equal(result.price.baseUnitCost, '0.006000');
});

test('an original exact GTIN-14 match wins without canonical fallback', async () => {
  const scanned = '07290000453897';
  const queries: string[] = [];
  const result = await prepareBarcodePrice({ ...ingredient, barcode: scanned }, async (query) => {
    queries.push(query);
    return [{ ...product, ItemCode: scanned }, { ...product, ItemCode: scanned.slice(1), score: 99999 }];
  });
  assert.deepEqual(queries, [scanned]);
  assert.equal(result.price.sku, scanned);
});

test('GTIN fallback rejects substring matches and different digits without stripping other prefixes', async () => {
  for (const [barcode, foundCode, expectedQueries] of [
    ['07290000453897', '72900004538979', ['07290000453897', '7290000453897']],
    ['07290000453897', '7290000453898', ['07290000453897', '7290000453897']],
    ['17290000453897', '7290000453897', ['17290000453897']],
  ] as const) {
    const queries: string[] = [];
    await assert.rejects(prepareBarcodePrice({ ...ingredient, barcode }, async (query) => {
      queries.push(query);
      return [{ ...product, ItemCode: foundCode }];
    }), { statusCode: 404 });
    assert.deepEqual(queries, expectedQueries);
  }
});

async function harness(responses: Record<string, unknown[]> = {}, search: typeof searchProduct = async () => [product], role = 'owner') {
  const app = await buildCatalogApp(role, search);
  const db = new FakeDb(responses);
  app.use({ db: db as never, deleteObject: async () => {} });
  return { ...app, db };
}

test('barcode pricing stores product identity and normalized price without changing the saved recipe', async () => {
  const h = await harness({
    'select:recipes': [[{ id: ID }]],
    'insert:generalPrices': [[{ id: PRICE_ID }]],
  }, async (query) => {
    assert.equal(query, BARCODE);
    return [{ ...product, ItemCode: `${BARCODE}9`, score: 99999 }, product];
  });
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/recipes/${ID}/barcode-price`,
      payload: { barcode: BARCODE, ...ingredient },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().price, {
      id: PRICE_ID, rawName: product.ItemName, sku: BARCODE, rawMaterialName: 'original supermarket milk',
      rawSrcUnit: 'l', srcUnit: 'l', quantity: 1,
      baseUnit: 'ml', baseUnitAmount: '1000.000', baseUnitCost: '0.006000',
    });
    assert.deepEqual(h.db.callSequence(), ['select:recipes', 'insert:generalPrices']);
    assert.equal(h.db.transactionCount, 0);
  } finally { await h.close(); }
});

test('barcode pricing rejects missing exact matches and invalid products without writes', async () => {
  const cases = [
    { products: [{ ...product, ItemCode: `${BARCODE}9` }], unit: 'l', status: 404 },
    { products: [{ ...product, Quantity: '' }], unit: 'l', status: 400 },
    { products: [{ ...product, ItemPrice: '-1' }], unit: 'l', status: 400 },
  ];
  for (const entry of cases) {
    const h = await harness({ 'select:recipes': [[{ id: ID }]] }, async () => entry.products);
    try {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/recipes/${ID}/barcode-price`,
        payload: { ...ingredient, barcode: BARCODE, rawSrcUnit: entry.unit },
      });
      assert.equal(response.statusCode, entry.status, response.body);
      assert.equal(h.db.callsTo('insert', 'generalPrices').length, 0);
    } finally { await h.close(); }
  }
});

test('scanned product normalization ignores the previous ingredient identity and incompatible or unresolved units', async () => {
  for (const unit of ['kg', 'pack', 'unknown']) {
    const h = await harness({
      'select:recipes': [[{ id: ID }]],
      'insert:generalPrices': [[{ id: PRICE_ID }]],
    });
    try {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/recipes/${ID}/barcode-price`,
        payload: { barcode: BARCODE, rawMaterialName: 'Unrelated flour', quantity: 2, rawSrcUnit: unit },
      });
      assert.equal(response.statusCode, 200, response.body);
      const price = response.json().price;
      assert.equal(price.rawName, product.ItemName);
      assert.equal(price.rawMaterialName, 'original supermarket milk');
      assert.equal(price.baseUnit, 'ml');
      assert.equal(price.baseUnitAmount, '1000.000');
      assert.equal(price.baseUnitCost, '0.006000');
      assert.equal(price.id, PRICE_ID);
      assert.deepEqual(h.db.onlyCallTo('insert', 'generalPrices').values, {
        rawName: price.rawName, rawMaterialName: price.rawMaterialName, sku: BARCODE,
        rawSrcUnit: 'l', srcUnit: 'l', baseUnit: 'ml',
        baseUnitAmount: '1000.000', baseUnitCost: '0.006000',
      });
      assert.deepEqual(h.db.callSequence(), ['select:recipes', 'insert:generalPrices']);
    } finally { await h.close(); }
  }
});

test('barcode pricing checks recipe ownership and mutation role before search or writes', async () => {
  for (const role of ['owner', 'member']) {
    const h = await harness({}, async () => { assert.fail('Must not search'); }, role);
    try {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/recipes/${ID}/barcode-price`, payload: { barcode: BARCODE, ...ingredient },
      });
      assert.equal(response.statusCode, role === 'member' ? 403 : 404);
      assert.equal(h.db.callsTo('insert', 'generalPrices').length, 0);
    } finally { await h.close(); }
  }
});

test('recipe edits atomically persist metadata and original ingredient fields with fresh converted quantities', async () => {
  const h = await harness({
    'select:recipes': [[{ id: ID }]], 'update:recipes': [[recipeRow({ id: ID, name: 'Edited recipe' })]],
  });
  try {
    const response = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`,
      payload: { name: 'Edited recipe', ingredients: [{
        ...ingredient, generalPriceId: PRICE_ID, baseUnit: 'g', baseUnitAmount: 999,
      }] },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.db.transactionCount, 1);
    assert.equal(h.db.onlyCallTo('update', 'recipes').inTransaction, true);
    assert.equal(h.db.onlyCallTo('delete', 'recipeIngredients').inTransaction, true);
    const insert = h.db.onlyCallTo('insert', 'recipeIngredients');
    assert.equal(insert.inTransaction, true);
    assert.deepEqual(insert.values, [{
      ...ingredient, shopId: SHOP_ID, recipeId: ID, generalPriceId: PRICE_ID, inventoryItemId: null,
      quantity: '0.250', baseUnit: 'ml', baseUnitAmount: '250.000',
    }]);
  } finally { await h.close(); }
});

test('recipe edits retain unresolved units rather than trusting stale base values', async () => {
  const h = await harness({ 'select:recipes': [[{ id: ID }]], 'update:recipes': [[recipeRow({ id: ID })]] });
  try {
    const response = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`,
      payload: { ingredients: [{ ...ingredient, rawSrcUnit: 'pack', baseUnit: 'ml', baseUnitAmount: 1000 }] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const [saved] = h.db.onlyCallTo('insert', 'recipeIngredients').values as Record<string, unknown>[];
    assert.equal(saved?.baseUnit, null);
    assert.equal(saved?.baseUnitAmount, null);
    assert.equal(saved?.rawSrcUnit, 'pack');
  } finally { await h.close(); }
});

test('recipe edits reject another shop inventory before changing metadata or ingredients', async () => {
  const h = await harness({ 'select:recipes': [[{ id: ID }]], 'select:inventoryItems': [[]] });
  try {
    const response = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`,
      payload: { name: 'Must not save', ingredients: [{ ...ingredient, inventoryItemId: INVENTORY_ID }] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(h.db.callsTo('update', 'recipes').length, 0);
    assert.equal(h.db.callsTo('delete', 'recipeIngredients').length, 0);
  } finally { await h.close(); }
});

test('metadata-only recipe edits preserve saved ingredients', async () => {
  const h = await harness({ 'select:recipes': [[{ id: ID }]], 'update:recipes': [[recipeRow({ id: ID })]] });
  try {
    const response = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`, payload: { prepTimeMinutes: 30 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.db.onlyCallTo('update', 'recipes').set?.prepTimeMinutes, 30);
    assert.equal(h.db.callsTo('delete', 'recipeIngredients').length, 0);
    assert.equal(h.db.callsTo('insert', 'recipeIngredients').length, 0);
  } finally { await h.close(); }
});

test('recipe ingredient save failure stays inside the metadata transaction', async () => {
  const h = await harness({ 'select:recipes': [[{ id: ID }]], 'update:recipes': [[recipeRow({ id: ID })]] });
  h.db.failOn('insert', 'recipeIngredients', new Error('Ingredient write failed'));
  try {
    const response = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`,
      payload: { name: 'Edited recipe', ingredients: [ingredient] },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(h.db.transactionCount, 1);
    assert.ok(h.db.calls.every((call) => call.inTransaction));
  } finally { await h.close(); }
});

test('scanned package pricing costs only the recipe amount and feeds recipe totals', async () => {
  const h = await harness({
    'select:recipes': [[{ id: ID }], [{ id: ID }]],
    'insert:generalPrices': [[{ id: PRICE_ID }]],
    'update:recipes': [[recipeRow({ id: ID })]],
  });
  try {
    const source = { ...ingredient, quantity: 250, rawSrcUnit: 'ml' };
    const scan = await h.app.inject({
      method: 'POST', url: `/api/v1/recipes/${ID}/barcode-price`, payload: { ...source, barcode: BARCODE },
    });
    assert.equal(scan.statusCode, 200, scan.body);
    const price = scan.json().price;
    const save = await h.app.inject({
      method: 'PATCH', url: `/api/v1/recipes/${ID}`,
      payload: { ingredients: [{ ...source, rawName: price.rawName, rawMaterialName: price.rawMaterialName, generalPriceId: price.id }] },
    });
    assert.equal(save.statusCode, 200, save.body);
    const [saved] = h.db.onlyCallTo('insert', 'recipeIngredients').values as Record<string, unknown>[];
    h.db.push('select', 'recipeIngredients', [{
      ...saved, id: 'line-1', name: price.rawName,
      averageUnitCost: price.baseUnitCost, currentQuantity: null,
    }]);
    const recipe = { id: ID, prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: null } as typeof recipes.$inferSelect;
    const costing = await costRecipe(SHOP_ID, recipe, '30', '0', h.db as unknown as Database);
    assert.equal(costing.costComplete, true);
    assert.equal(costing.ingredients[0]?.rawName, product.ItemName);
    assert.equal(saved?.rawMaterialName, price.rawMaterialName);
    assert.equal(costing.ingredients[0]?.quantity, 250);
    assert.equal(costing.ingredients[0]?.rawSrcUnit, 'ml');
    assert.equal(costing.ingredients[0]?.lineCost, 1.5);
    assert.equal(costing.ingredientsCost, 1.5);
    assert.equal(costing.batchCost, 1.5);
    assert.equal(costing.unitCost, 1.5);
    assert.equal(costing.retailPrice, 1.95);
  } finally { await h.close(); }
});

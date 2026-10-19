import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { findProductByBarcode, linkIngredientByBarcode } from '../src/lib/recipePriceFallback.js';
import { mapIngredientValues, costRecipe } from '../src/routes/catalog.js';
import { buildCatalogApp } from './support/catalogApp.js';
import { priceResult } from './support/priceResult.js';
import { FakeDb } from './support/fakeDb.js';
import type { Database } from '../src/db/client.js';

const asDatabase = (db: FakeDb) => db as unknown as Database;
const product = priceResult({ ItemCode: '7290001234567', ItemPrice: '10', Quantity: '1', UnitQty: 'l', bIsWeighted: '0' });
const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INGREDIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('findProductByBarcode finds exact match', async () => {
  const search = async () => [product];
  const found = await findProductByBarcode('7290001234567', search as any);
  assert.ok(found);
  assert.equal(found?.ItemCode, '7290001234567');
});

test('findProductByBarcode retries with 0 prefix for all digits', async () => {
  const searchCalls: string[] = [];
  const search = async (q: string) => {
    searchCalls.push(q);
    if (q === '1234567') return [];
    if (q === '01234567') return [{ ...product, ItemCode: '01234567' }];
    return [];
  };
  const found = await findProductByBarcode('1234567', search as any);
  assert.ok(found);
  assert.equal(found?.ItemCode, '01234567');
  assert.deepEqual(searchCalls, ['1234567', '01234567']);
});

test('findProductByBarcode returns null when not found', async () => {
  const search = async () => [];
  const found = await findProductByBarcode('999', search as any);
  assert.equal(found, null);
});

test('linkIngredientByBarcode success upserts and links', async () => {
  const db = new FakeDb({
    'select:recipeIngredients': [[
      { id: 'ing-1', inventoryItemId: null, rawMaterialName: 'Milk' }
    ]],
    'insert:generalPrices': [[{ id: 'gp-1' }]],
  });
  const res = await linkIngredientByBarcode(asDatabase(db), { shopId: 's-1', recipeId: 'r-1', ingredientId: 'ing-1', barcode: product.ItemCode }, async () => [product] as any);
  assert.equal(res.generalPriceId, 'gp-1');
  const insert = db.onlyCallTo('insert', 'generalPrices').values as Record<string, unknown>;
  assert.equal(insert.rawMaterialName, 'milk');
  assert.equal(insert.sku, product.ItemCode);
  assert.equal(insert.baseUnitAmount, '1000.000');
  const upd = db.onlyCallTo('update', 'recipeIngredients');
  assert.deepEqual(upd.set, { generalPriceId: 'gp-1' });
});

test('linkIngredientByBarcode ingredient not found throws 404', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[]] });
  await assert.rejects(
    () => linkIngredientByBarcode(asDatabase(db), { shopId: 's-1', recipeId: 'r-1', ingredientId: 'ing-1', barcode: '1234' }, async () => [] as any),
    (e: any) => e.statusCode === 404 && e.code === 'NOT_FOUND'
  );
});

test('linkIngredientByBarcode inventory linked throws 409', async () => {
  const db = new FakeDb({
    'select:recipeIngredients': [[
      { id: 'ing-1', recipeId: 'r-1', shopId: 's-1', inventoryItemId: 'inv-1', generalPriceId: null, rawMaterialName: 'Milk', rawName: 'Milk' }
    ]]
  });
  await assert.rejects(
    () => linkIngredientByBarcode(asDatabase(db), { shopId: 's-1', recipeId: 'r-1', ingredientId: 'ing-1', barcode: '1234' }, async () => [] as any),
    (e: any) => e.statusCode === 409 && e.code === 'CONFLICT'
  );
});

test('linkIngredientByBarcode no product throws 404', async () => {
  const db = new FakeDb({
    'select:recipeIngredients': [[
      { id: 'ing-1', recipeId: 'r-1', shopId: 's-1', inventoryItemId: null, generalPriceId: null, rawMaterialName: 'Milk', rawName: 'Milk' }
    ]]
  });
  await assert.rejects(
    () => linkIngredientByBarcode(asDatabase(db), { shopId: 's-1', recipeId: 'r-1', ingredientId: 'ing-1', barcode: '12345678' }, async () => [] as any),
    (e: any) => e.statusCode === 404 && e.code === 'NOT_FOUND'
  );
});

test('linkIngredientByBarcode unreadable price throws 400', async () => {
  const bad = { ...product, ItemPrice: 'bad' };
  const db = new FakeDb({
    'select:recipeIngredients': [[
      { id: 'ing-1', recipeId: 'r-1', shopId: 's-1', inventoryItemId: null, generalPriceId: null, rawMaterialName: 'Milk', rawName: 'Milk' }
    ]]
  });
  await assert.rejects(
    () => linkIngredientByBarcode(asDatabase(db), { shopId: 's-1', recipeId: 'r-1', ingredientId: 'ing-1', barcode: bad.ItemCode }, async () => [bad] as any),
    (e: any) => e.statusCode === 400 && e.code === 'BAD_REQUEST'
  );
});

async function harnessLink(responses: Record<string, unknown[]>) {
  const db = new FakeDb(responses);
  const app = await buildCatalogApp();
  app.use({ db: db as never, deleteObject: async () => {} });
  return {
    db,
    async post(payload: unknown) {
      const response = await app.app.inject({
        method: 'POST',
        url: `/api/v1/recipes/${RECIPE_ID}/ingredients/${INGREDIENT_ID}/link`,
        payload: payload as object,
      });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => app.close(),
  };
}

test('POST link rejects a missing or short barcode with 400 before any database call', async () => {
  for (const payload of [{}, { barcode: 'ab' }, { barcode: 12345 }]) {
    const h = await harnessLink({});
    try {
      const { status, body } = await h.post(payload);
      assert.equal(status, 400);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(h.db.calls.length, 0);
    } finally {
      await h.close();
    }
  }
});

test('POST link returns 404 for an unknown recipe before touching ingredients', async () => {
  const h = await harnessLink({ 'select:recipes': [[]] });
  try {
    const { status, body } = await h.post({ barcode: '7290001234567' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Recipe not found');
    assert.deepEqual(h.db.callSequence(), ['select:recipes']);
  } finally {
    await h.close();
  }
});

test('POST link returns 404 for an unknown ingredient and never searches', async () => {
  const h = await harnessLink({
    'select:recipes': [[{ id: RECIPE_ID }]],
    'select:recipeIngredients': [[]],
  });
  try {
    const { status, body } = await h.post({ barcode: '7290001234567' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Ingredient not found');
    assert.equal(h.db.callsTo('insert', 'generalPrices').length, 0);
  } finally {
    await h.close();
  }
});

test('POST link returns 409 when the ingredient is inventory-linked and never searches', async () => {
  const h = await harnessLink({
    'select:recipes': [[{ id: RECIPE_ID }]],
    'select:recipeIngredients': [[
      { id: INGREDIENT_ID, inventoryItemId: 'inv-1', generalPriceId: null, rawMaterialName: 'Milk', rawName: 'Milk' }
    ]],
  });
  try {
    const { status, body } = await h.post({ barcode: '7290001234567' });
    assert.equal(status, 409);
    assert.equal(body.error.code, 'CONFLICT');
    assert.equal(body.error.message, 'Ingredient is linked to inventory');
    assert.equal(h.db.callsTo('insert', 'generalPrices').length, 0);
  } finally {
    await h.close();
  }
});

test('mapIngredientValues converts omitted base fields from quantity and unit', () => {
  const values = mapIngredientValues({
    rawName: 'Flour', rawMaterialName: 'flour', quantity: 1, rawSrcUnit: 'kg',
  });
  assert.equal(values.baseUnit, 'g');
  assert.equal(values.baseUnitAmount, '1000.000');
  assert.equal(values.rawMaterialName, 'flour');
  assert.equal(values.quantity, '1.000');
  assert.equal(values.inventoryItemId, null);
  assert.equal(values.generalPriceId, null);
});

test('mapIngredientValues passes through explicit base fields unchanged', () => {
  const values = mapIngredientValues({
    rawName: 'Milk', quantity: 2, rawSrcUnit: 'l', baseUnit: 'ml', baseUnitAmount: 250.5,
  });
  assert.equal(values.baseUnit, 'ml');
  assert.equal(values.baseUnitAmount, '250.500');
});

test('mapIngredientValues resolves an unresolvable unit to nulls', () => {
  const values = mapIngredientValues({
    rawName: 'Mystery', quantity: 1, rawSrcUnit: 'box',
  });
  assert.equal(values.baseUnit, null);
  assert.equal(values.baseUnitAmount, null);
});

test('costRecipe ingredients carry their recipe_ingredients id', async () => {
  const db = new FakeDb({ 'select:recipeIngredients': [[
    { id: 'ing-7', inventoryItemId: 'inv-1', generalPriceId: null, rawName: 'Flour', quantity: '2', baseUnitAmount: '2', rawSrcUnit: 'kg', averageUnitCost: '4', currentQuantity: '10' },
  ]] });
  const recipe = { id: 'recipe-1', prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: '30' } as any;
  const costing = await costRecipe('shop-1', recipe, '30', '0', asDatabase(db));
  assert.equal(costing.ingredients[0]?.id, 'ing-7');
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { manualProductSchema, prepareManualProduct } from '../src/lib/manualProduct.js';
import { ingredientLineCost } from '../src/lib/pricing.js';
import { costRecipe } from '../src/routes/catalog.js';
import type { Database } from '../src/db/client.js';
import type { recipes } from '../src/db/schema/index.js';

const ID = '66666666-6666-6666-6666-666666666666';
const PRODUCT_ID = '88888888-8888-8888-8888-888888888888';
const input = { name: 'Unsalted butter', price: 4.5, packageSize: 250,
  packageUnit: 'g' as const, rawMaterialName: 'Butter', quantity: 120, rawSrcUnit: 'g' };

test('manual package prices use recipe conversions and preserve a legitimate zero price', () => {
  for (const [packageUnit, packageSize, rawSrcUnit, quantity, expected] of [
    ['g', 250, 'g', 120, 2.16], ['kg', 0.25, 'kg', 0.12, 2.16],
    ['ml', 500, 'ml', 250, 2.25], ['l', 0.5, 'l', 0.25, 2.25],
    ['pcs', 12, 'each', 6, 2.25],
  ] as const) {
    const product = prepareManualProduct({ ...input, packageUnit, packageSize, rawSrcUnit, quantity });
    const baseAmount = quantity * (rawSrcUnit === 'kg' || rawSrcUnit === 'l' ? 1000 : 1);
    assert.ok(Math.abs(ingredientLineCost({ quantity: baseAmount, averageUnitCost: product.baseUnitAverageCost })! - expected) < 1e-9);
  }
  assert.equal(prepareManualProduct({ ...input, price: 0 }).baseUnitCost, '0.000000');
  for (const rawSrcUnit of ['ml', 'pack', 'unknown']) {
    assert.throws(() => prepareManualProduct({ ...input, rawSrcUnit }), { statusCode: 400 });
  }
});

test('manual product endpoint creates shop-owned pricing with no stock or shared cache writes', async () => {
  const h = await buildCatalogApp();
  const db = new FakeDb({ 'select:recipes': [[{ id: ID }]], 'insert:inventoryItems': [[{ id: PRODUCT_ID }]] });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: input });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().product.id, PRODUCT_ID);
    assert.deepEqual(db.callsTo('insert', 'inventoryItems')[0]?.values, {
      ...prepareManualProduct(input), shopId: SHOP_ID,
    });
    assert.deepEqual(db.callSequence(), ['select:recipes', 'insert:inventoryItems']);
  } finally { await h.close(); }
});

test('manual product guards validation, ownership, permissions, incompatible units and duplicates', async () => {
  for (const entry of [
    { role: 'member', recipe: true, body: input, status: 403 },
    { role: 'owner', recipe: false, body: input, status: 404 },
    { role: 'owner', recipe: true, body: { ...input, price: -1 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, name: '<b>Butter</b>' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, packageSize: 0 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, packageUnit: 'pack' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, rawSrcUnit: 'ml' }, status: 400 },
    { role: 'owner', recipe: true, body: input, status: 409 },
  ]) {
    const h = await buildCatalogApp(entry.role);
    const db = new FakeDb({ 'select:recipes': [entry.recipe ? [{ id: ID }] : []], 'insert:inventoryItems': [[]] });
    h.use({ db: db as never, deleteObject: async () => {} });
    try {
      const response = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: entry.body });
      assert.equal(response.statusCode, entry.status, response.body);
      if (entry.status !== 409) assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
      assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
    } finally { await h.close(); }
  }
  for (const body of [{ ...input, price: Infinity }, { ...input, packageSize: NaN }]) {
    assert.equal(manualProductSchema.safeParse(body).success, false);
  }
});

test('a saved manual product link retains recipe quantities and produces the correct recipe costing', async () => {
  const h = await buildCatalogApp();
  const product = { ...prepareManualProduct(input), id: PRODUCT_ID };
  const db = new FakeDb({
    'select:recipes': [[{ id: ID }], [{ id: ID }]],
    'insert:inventoryItems': [[product]],
    'select:inventoryItems': [[{ id: PRODUCT_ID }]],
    'update:recipes': [[{ id: ID }]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const create = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: input });
    assert.equal(create.statusCode, 201, create.body);
    const save = await h.app.inject({ method: 'PATCH', url: `/api/v1/recipes/${ID}`, payload: {
      ingredients: [{ rawName: product.name, rawMaterialName: input.rawMaterialName,
        quantity: input.quantity, rawSrcUnit: input.rawSrcUnit, inventoryItemId: create.json().product.id }],
    } });
    assert.equal(save.statusCode, 200, save.body);
    const [saved] = db.onlyCallTo('insert', 'recipeIngredients').values as Record<string, unknown>[];
    assert.equal(saved?.inventoryItemId, PRODUCT_ID);
    assert.equal(saved?.generalPriceId, null);
    assert.equal(saved?.baseUnitAmount, '120.000');
    db.push('select', 'recipeIngredients', [{ ...saved, id: 'line-1', name: product.name,
      averageUnitCost: product.baseUnitAverageCost, currentQuantity: '0' }]);
    const recipe = { id: ID, prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: null } as typeof recipes.$inferSelect;
    const costing = await costRecipe(SHOP_ID, recipe, '30', '0', db as unknown as Database);
    assert.equal(costing.costComplete, true);
    assert.equal(costing.ingredientsCost, 2.16);
    assert.equal(costing.unitCost, 2.16);
    assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
  } finally { await h.close(); }
});

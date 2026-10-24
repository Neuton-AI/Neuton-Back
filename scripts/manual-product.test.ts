import './support/testEnv.js';
import { recipeRow } from './support/recipeFixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { manualProductSchema, prepareManualProduct } from '../src/lib/manualProduct.js';
import { ingredientLineCost } from '../src/lib/pricing.js';
import { costRecipe } from '../src/modules/catalog/costing.js';
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
    assert.ok(Math.abs(ingredientLineCost({ quantity: baseAmount, averageUnitCost: product.baseUnitCost })! - expected) < 1e-9);
  }
  assert.equal(prepareManualProduct({ ...input, price: 0 }).baseUnitCost, '0.000000');
  for (const rawSrcUnit of ['ml', 'pack', 'unknown']) {
    assert.throws(() => prepareManualProduct({ ...input, rawSrcUnit }), { statusCode: 400 });
  }
});

test('manual product endpoint saves normalized package pricing to general prices without inventory writes', async () => {
  const h = await buildCatalogApp();
  const db = new FakeDb({ 'select:recipes': [[{ id: ID }]], 'insert:generalPrices': [[{ id: PRODUCT_ID }]] });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: input });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().product.id, PRODUCT_ID);
    assert.equal(response.json().product.name, input.name);
    assert.equal(response.json().product.rawMaterialName, input.name);
    assert.equal(response.json().usage.baseUnit, 'g');
    assert.equal(response.json().usage.baseUnitAmount, 120);
    const saved = db.onlyCallTo('insert', 'generalPrices').values as Record<string, unknown>;
    assert.equal(saved.rawName, input.name);
    assert.equal(saved.rawSrcUnit, 'g');
    assert.equal(saved.baseUnit, 'g');
    assert.equal(saved.baseUnitAmount, '250.000');
    assert.equal(saved.baseUnitCost, '0.018000');
    assert.equal(saved.shopId, undefined);
    assert.deepEqual(db.callSequence(), ['select:recipes', 'insert:generalPrices']);
  } finally { await h.close(); }
});

test('manual product guards validation, ownership, permissions and submitted usage compatibility', async () => {
  for (const entry of [
    { role: 'member', recipe: true, body: input, status: 403 },
    { role: 'owner', recipe: false, body: input, status: 404 },
    { role: 'owner', recipe: true, body: { ...input, price: -1 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, name: '<b>Butter</b>' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, packageSize: 0 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, packageUnit: 'pack' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, rawSrcUnit: 'ml' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, rawSrcUnit: 'unknown' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, rawSrcUnit: 'each' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, quantity: 0 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, quantity: -1 }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, quantity: undefined }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, rawSrcUnit: '' }, status: 400 },
    { role: 'owner', recipe: true, body: { ...input, price: 0.000001 }, status: 400 },
  ]) {
    const h = await buildCatalogApp(entry.role);
    const db = new FakeDb({ 'select:recipes': [entry.recipe ? [{ id: ID }] : []] });
    h.use({ db: db as never, deleteObject: async () => {} });
    try {
      const response = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: entry.body });
      assert.equal(response.statusCode, entry.status, response.body);
      assert.equal(db.callsTo('insert', 'generalPrices').length, 0);
      assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
      assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
    } finally { await h.close(); }
  }
  for (const body of [{ ...input, price: Infinity }, { ...input, packageSize: NaN }, { ...input, quantity: NaN }]) {
    assert.equal(manualProductSchema.safeParse(body).success, false);
  }
});

test('same-name manual products create independent general prices without mutating an existing price', async () => {
  const h = await buildCatalogApp();
  const secondId = '99999999-9999-9999-9999-999999999999';
  const db = new FakeDb({
    'select:recipes': [[{ id: ID }], [{ id: ID }]],
    'insert:generalPrices': [[{ id: PRODUCT_ID }], [{ id: secondId }]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const first = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: input });
    const second = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: { ...input, price: 5 } });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(first.json().product.id, PRODUCT_ID);
    assert.equal(second.json().product.id, secondId);
    assert.equal(db.callsTo('insert', 'generalPrices').length, 2);
    assert.equal(db.callsTo('update', 'generalPrices').length, 0);
    assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
  } finally { await h.close(); }
});

test('manual replacement saves selected recipe usage and general-price link with correct normalized costing', async () => {
  const h = await buildCatalogApp();
  // The extracted line was "2 pieces". The user corrects it to 0.15 kg of this
  // 500 g package; neither the extracted count nor the package size is usage.
  const selected = { ...input, price: 10, packageSize: 500, quantity: 0.15, rawSrcUnit: 'kg' };
  const db = new FakeDb({
    'select:recipes': [[{ id: ID }], [{ id: ID }]],
    'insert:generalPrices': [[{ id: PRODUCT_ID }]],
    'update:recipes': [[recipeRow({ id: ID })]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const create = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/manual-product`, payload: selected });
    assert.equal(create.statusCode, 201, create.body);
    const save = await h.app.inject({ method: 'PATCH', url: `/api/v1/recipes/${ID}`, payload: {
      ingredients: [{ rawName: selected.name, rawMaterialName: selected.rawMaterialName,
        quantity: selected.quantity, rawSrcUnit: selected.rawSrcUnit,
        generalPriceId: create.json().product.id, inventoryItemId: null }],
    } });
    assert.equal(save.statusCode, 200, save.body);
    const [saved] = db.onlyCallTo('insert', 'recipeIngredients').values as Record<string, unknown>[];
    assert.equal(saved?.inventoryItemId, null);
    assert.equal(saved?.generalPriceId, PRODUCT_ID);
    assert.equal(saved?.quantity, '0.150');
    assert.equal(saved?.rawSrcUnit, 'kg');
    assert.equal(saved?.baseUnit, 'g');
    assert.equal(saved?.baseUnitAmount, '150.000');
    const price = db.onlyCallTo('insert', 'generalPrices').values as Record<string, unknown>;
    assert.equal(price.baseUnitAmount, '500.000');
    assert.equal(price.baseUnitCost, '0.020000');
    db.push('select', 'recipeIngredients', [{ ...saved, id: 'line-1', name: selected.name,
      averageUnitCost: price.baseUnitCost, currentQuantity: '0' }]);
    const recipe = { id: ID, prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: null } as typeof recipes.$inferSelect;
    const costing = await costRecipe(SHOP_ID, recipe, '30', '0', db as unknown as Database);
    assert.equal(costing.costComplete, true);
    assert.equal(costing.ingredientsCost, 3);
    assert.equal(costing.unitCost, 3);
    assert.equal(costing.ingredients[0]?.generalPriceId, PRODUCT_ID);
    assert.equal(costing.ingredients[0]?.baseUnitAmount, '150.000');
    assert.equal(db.callsTo('insert', 'inventoryItems').length, 0);
    assert.equal(db.callsTo('update', 'inventoryItems').length, 0);
  } finally { await h.close(); }
});

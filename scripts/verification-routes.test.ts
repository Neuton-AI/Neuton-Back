import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { buildReceiptsApp } from './support/receiptsApp.js';

const ID = '66666666-6666-6666-6666-666666666666';
const LINE_ID = '77777777-7777-7777-7777-777777777777';
const INGREDIENT = { rawName: 'Flour', quantity: 2, unit: 'kg' };

async function catalog(responses: Record<string, unknown[]> = {}, role = 'owner') {
  const h = await buildCatalogApp(role);
  const db = new FakeDb(responses);
  h.use({ db: db as never, deleteObject: async () => {} });
  return { ...h, db };
}

test('recipe verification saves corrections and verifies in one transaction', async () => {
  const h = await catalog({
    'select:recipes': [[{ id: ID, status: 'unverified' }]],
    'update:recipes': [[{ id: ID, status: 'verified' }]],
  });
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/recipes/${ID}/verify`,
      payload: { ingredients: [INGREDIENT] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { recipe: { id: ID, status: 'verified' } });
    assert.equal(h.db.onlyCallTo('update', 'recipes').set?.status, 'verified');
    assert.equal(h.db.onlyCallTo('delete', 'recipeIngredients').inTransaction, true);
    const insert = h.db.onlyCallTo('insert', 'recipeIngredients');
    assert.equal(insert.inTransaction, true);
    assert.deepEqual(insert.values, [{
      shopId: SHOP_ID, recipeId: ID, inventoryItemId: null,
      rawName: 'Flour', searchAbleName: 'Flour', quantity: '2.000', unit: 'kg',
    }]);
    assert.equal(h.db.calls.some((call) => call.table === 'receipts'), false);
  } finally { await h.close(); }
});

test('recipe verification without corrections preserves ingredients', async () => {
  const h = await catalog({
    'select:recipes': [[{ id: ID, status: 'unverified' }]],
    'update:recipes': [[{ id: ID, status: 'verified' }]],
  });
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/recipes/${ID}/verify`, payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.db.callsTo('delete', 'recipeIngredients'), []);
    assert.deepEqual(h.db.callsTo('insert', 'recipeIngredients'), []);
  } finally { await h.close(); }
});

test('recipe verification preserves missing and already-verified errors without writes', async () => {
  for (const [rows, expected] of [[[], 404], [[{ id: ID, status: 'verified' }], 409]] as const) {
    const h = await catalog({ 'select:recipes': [rows] });
    try {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/recipes/${ID}/verify`, payload: {},
      });
      assert.equal(response.statusCode, expected);
      assert.deepEqual(h.db.callsTo('update', 'recipes'), []);
    } finally { await h.close(); }
  }
});

test('recipe verification rejects invalid IDs and invalid corrections before database access', async () => {
  const h = await catalog();
  try {
    for (const [id, payload] of [
      ['invalid', {}], [ID, { ingredients: [] }],
      [ID, { ingredients: [{ ...INGREDIENT, quantity: 0 }] }],
      [ID, { ingredients: [{ ...INGREDIENT, rawName: '<script>bad</script>' }] }],
    ] as const) {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/recipes/${id}/verify`, payload,
      });
      assert.equal(response.statusCode, 400);
    }
    assert.deepEqual(h.db.calls, []);
  } finally { await h.close(); }
});

test('recipe verification still requires an owner or admin', async () => {
  const h = await catalog({}, 'member');
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/recipes/${ID}/verify`, payload: {},
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(h.db.calls, []);
  } finally { await h.close(); }
});

test('the shared catalog verification URLs are removed for both entity types', async () => {
  const h = await catalog();
  try {
    for (const type of ['receipt', 'recipe']) {
      const response = await h.app.inject({
        method: 'POST', url: `/api/v1/catalog/${type}/${ID}/verify`, payload: {},
      });
      assert.equal(response.statusCode, 404);
    }
    assert.deepEqual(h.db.calls, []);
  } finally { await h.close(); }
});

test('receipt verification uses its own route and preserves corrected source units', async () => {
  const h = await buildReceiptsApp();
  const db = new FakeDb({
    'select:receipts': [[{ id: ID, status: 'unverified' }]],
    'select:receiptItems': [[{
      id: LINE_ID, rawName: 'Flour', srcUnit: 'g', quantity: '1.000', unitPrice: '2.0000',
    }]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/receipts/${ID}/verify`,
      payload: { items: [{ id: LINE_ID, accepted: false, srcUnit: 'kg' }] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { receiptId: ID, status: 'verified', accepted: 0, rejected: 1 });
    assert.equal(db.onlyCallTo('update', 'receiptItems').set?.srcUnit, 'kg');
    assert.equal(db.onlyCallTo('update', 'receipts').set?.status, 'verified');
    assert.deepEqual(db.callsTo('update', 'inventoryItems'), []);
    assert.equal(db.calls.some((call) => call.table === 'recipes'), false);
  } finally { await h.close(); }
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/db/client.js';
import { buildCatalogApp } from './support/catalogApp.js';
import { FakeDb } from './support/fakeDb.js';
import { recipeRow } from './support/recipeFixture.js';

const recipe = recipeRow({ status: 'verified', yieldQuantity: '3', prepTimeMinutes: 12 });
const known = { id: 'known', quantity: '1', baseUnitAmount: '1', averageUnitCost: '5', currentQuantity: '0' };
const unresolved = { id: 'missing', quantity: '1', baseUnitAmount: null, averageUnitCost: null };

test('list, detail and sync snapshots expose partial pricing without changing incomplete costing', async () => {
  const h = await buildCatalogApp();
  try {
    for (const url of ['/api/v1/recipes', `/api/v1/recipes/${recipe.id}`]) {
      for (const snapshot of [false, true]) {
        const db = new FakeDb({
          'select:recipes': [[recipe]],
          'select:recipeIngredients': [[known, unresolved]],
          'select:mediaUploads': [[]],
        });
        const database = Object.assign(db, { execute: async () => [{ updated_at: 7 }] });
        h.use({ db: database as unknown as Database });
        const response = await h.app.inject({
          method: 'GET', url, headers: { 'x-sync-snapshot': String(snapshot) },
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        const document = body.recipe ?? body.recipes[0];
        assert.deepEqual(document.orderPricing, {
          unitPrice: '3.33', unitCost: '3.3333', costComplete: false,
        });
        assert.equal(document.orderPricingError, null);
        assert.equal(document.costing.costComplete, false);
        assert.equal(document.costing.unitCost, null);
        assert.equal(document.costing.batchCost, null);
        assert.equal(document.costing.retailPrice, null);
        assert.equal(document.costing.ingredientsCost, 5);
        assert.equal(document.costing.laborCost, 5);
        assert.equal(document.costing.unresolvedCount, 1);
        if (snapshot && body.recipe) {
          assert.equal(body.syncVersion, 7);
        }
      }
    }
  } finally {
    await h.close();
  }
});

test('a malformed recipe does not prevent the catalog from returning valid prices', async () => {
  const h = await buildCatalogApp();
  try {
    const db = new FakeDb({
      'select:recipes': [[{ ...recipe, id: 'bad-yield', yieldQuantity: '0' }, recipe]],
      'select:recipeIngredients': [[known], [known]],
    });
    h.use({ db: db as unknown as Database });
    const response = await h.app.inject({ method: 'GET', url: '/api/v1/recipes' });
    assert.equal(response.statusCode, 200, response.body);
    const [invalid, valid] = response.json().recipes;
    assert.equal(invalid.orderPricing, null);
    assert.equal(invalid.orderPricingError.code, 'INVALID_RECIPE_YIELD');
    assert.equal(invalid.costing.unitCost, null);
    assert.deepEqual(valid.orderPricing, {
      unitPrice: '4.33', unitCost: '3.3333', costComplete: true,
    });
    assert.equal(valid.costing.inStock, false, 'stock does not suppress pricing');
    assert.equal(db.callsTo('update', 'recipes').length, 0);
    assert.equal(db.callsTo('delete', 'recipes').length, 0);
  } finally {
    await h.close();
  }
});

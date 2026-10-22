import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogApp } from './support/catalogApp.js';
import { FakeDb } from './support/fakeDb.js';

const ID = '66666666-6666-4666-8666-666666666666';
const FOREIGN_ID = '88888888-8888-4888-8888-888888888888';
const ingredient = { rawName: 'Flour', quantity: 1, rawSrcUnit: 'kg', inventoryItemId: FOREIGN_ID };

for (const method of ['POST', 'PATCH'] as const) {
  test(`${method} recipe rejects foreign category/inventory before writes`, async () => {
    for (const payload of [{ name: 'Test', ingredients: [ingredient] }, { name: 'Test', ingredients: [{ ...ingredient, inventoryItemId: undefined }], categoryId: FOREIGN_ID }]) {
      const h = await buildCatalogApp();
      const db = new FakeDb({ 'select:recipes': [[{ id: ID }]], 'insert:recipes': [[{ id: ID }]], 'update:recipes': [[{ id: ID }]] });
      h.use({ db: db as never, deleteObject: async () => {} });
      try {
        const response = await h.app.inject({ method, url: `/api/v1/recipes${method === 'PATCH' ? `/${ID}` : ''}`, payload });
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(db.calls.filter(call => call.op !== 'select').length, 0);
      } finally { await h.close(); }
    }
  });
}

test('verification rejects foreign inventory before status change or ingredient deletion', async () => {
  const h = await buildCatalogApp();
  const db = new FakeDb({ 'select:recipes': [[{ id: ID, status: 'unverified' }]], 'update:recipes': [[{ id: ID, status: 'verified' }]] });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${ID}/verify`, payload: { ingredients: [ingredient] } });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(db.calls.filter(call => call.op !== 'select').length, 0);
  } finally { await h.close(); }
});

for (const method of ['POST', 'PATCH'] as const) {
  test(`${method} inventory rejects a foreign category before writes`, async () => {
    const h = await buildCatalogApp();
    const db = new FakeDb({ 'select:inventoryItems': [[{ id: ID }]], 'insert:inventoryItems': [[{ id: ID }]], 'update:inventoryItems': [[{ id: ID }]] });
    h.use({ db: db as never, deleteObject: async () => {} });
    try {
      const response = await h.app.inject({ method, url: `/api/v1/inventory${method === 'PATCH' ? `/${ID}` : ''}`, payload: {
        name: 'Flour', rawMaterialName: 'Flour', unit: 'kg', baseUnit: 'g', baseUnitAmount: 1000, baseUnitCost: 0.01, categoryId: FOREIGN_ID,
      } });
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(db.calls.filter(call => call.op !== 'select').length, 0);
    } finally { await h.close(); }
  });
}

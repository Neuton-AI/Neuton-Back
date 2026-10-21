import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogApp } from './support/catalogApp.js';
import { FakeDb } from './support/fakeDb.js';

const ID = '66666666-6666-4666-8666-666666666666';
const KEY = '77777777-7777-4777-8777-777777777777';
test('stock adjustment uses one transaction and a durable claim before applying stock', async () => {
  const h = await buildCatalogApp();
  const db = new FakeDb({ 'insert:inventoryAdjustmentBatches': [[{ id: KEY }]], 'select:inventoryItems': [[{ id: ID }]] });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({ method: 'POST', url: '/api/v1/inventory/adjust', headers: { 'idempotency-key': KEY }, payload: { adjustments: [{ inventoryItemId: ID, deltaQuantity: 2 }] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { adjusted: 1, ids: [ID] });
    assert.equal(db.transactionCount, 1);
    assert.ok(db.calls.every(call => call.inTransaction));
    assert.equal(db.callSequence()[0], 'insert:inventoryAdjustmentBatches');
    assert.equal(db.callsTo('update', 'inventoryItems').length, 1);
  } finally { await h.close(); }
});

test('duplicate item IDs and malformed retry keys are rejected before any database work', async () => {
  const h = await buildCatalogApp();
  const db = new FakeDb();
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const item = { inventoryItemId: ID, deltaQuantity: 2 };
    for (const [key, adjustments] of [[KEY, [item, item]], ['invalid', [item]]] as const) {
      const response = await h.app.inject({ method: 'POST', url: '/api/v1/inventory/adjust', headers: { 'idempotency-key': key }, payload: { adjustments } });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.deepEqual(db.calls, []);
  } finally { await h.close(); }
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { FakeDb } from './support/fakeDb.js';
import { buildNestOrdersApp, TEST_SHOP } from './support/nestOrdersApp.js';
import { orderRow } from './support/orderFixture.js';
const recipeId = '11111111-1111-1111-1111-111111111111';
const missingId = '55555555-5555-5555-5555-555555555555';
const recipe = { id: recipeId, name: 'Focaccia', isActive: true, status: 'verified', yieldQuantity: '1', prepTimeMinutes: 0, targetMarginPct: null };
const headers = { cookie: '__Host-neuton-session=test', 'x-shop-id': TEST_SHOP.id };
const input = { customerName: 'Dana', destinationAddress: 'Market Street', deliveryFee: 0,
  items: [{ recipeId, quantity: 1, expectedUnitPrice: '2.60' }] };
function database(rows = [recipe], margin = '30') {
  return new FakeDb({ 'select:shops': [[{ ...TEST_SHOP, targetProfitMargin: margin }]],
    'select:recipes': [rows], 'select:recipeIngredients': [[{ recipeId, quantity: '1', averageUnitCost: '2' }]],
    'update:shops': [[{ lastOrderNumber: 1 }]], 'insert:orders': [[orderRow()]], 'insert:orderItems': [[]] });
}
test('ordinary create owns source reads and writes in one transaction and reloads shop prices', async () => {
  const db = database([recipe], '50');
  const h = await buildNestOrdersApp('owner', db as never);
  try {
    const result = await request(h.app.getHttpServer()).post('/api/v1/orders').set(headers)
      .send({ ...input, items: [{ ...input.items[0], expectedUnitPrice: '3.00' }] });
    assert.equal(result.status, 201, result.text);
    assert.equal(result.body.totals.totalAmount, 3);
    assert.equal(db.transactionCount, 1);
    assert.ok(db.calls.every(call => call.inTransaction));
    assert.equal(h.audits.length, 1);
  } finally { await h.close(); }
});
test('combined conflicts produce no order, number, line or audit effects', async () => {
  const db = database();
  const h = await buildNestOrdersApp('owner', db as never);
  try {
    const result = await request(h.app.getHttpServer()).post('/api/v1/orders').set(headers).send({ ...input,
      items: [{ recipeId, quantity: 1, expectedUnitPrice: '1.00' }, { recipeId: missingId, quantity: 1, expectedUnitPrice: '0.00' }] });
    assert.equal(result.status, 409, result.text);
    assert.equal(result.body.error.code, 'ORDER_REVIEW_REQUIRED');
    assert.deepEqual(result.body.error.details.reasons, ['PRICE_CHANGED', 'AVAILABILITY_CHANGED']);
    assert.deepEqual(result.body.error.details.unavailable, [{ recipeId: missingId, reason: 'NOT_FOUND' }]);
    assert.equal(db.calls.filter(call => call.op !== 'select').length, 0);
    assert.equal(h.audits.length, 0);
  } finally { await h.close(); }
});
test('confirmed missing items are excluded and reappeared items require review', async () => {
  for (const confirmed of [missingId, recipeId]) {
    const db = database();
    const h = await buildNestOrdersApp('owner', db as never);
    try {
      const result = await request(h.app.getHttpServer()).post('/api/v1/orders').set(headers).send({ ...input,
        items: [...input.items, { recipeId: missingId, quantity: 1, expectedUnitPrice: '0.00' }], confirmedUnavailableRecipeIds: [confirmed] });
      assert.equal(result.status, confirmed === missingId ? 201 : 409, result.text);
      if (result.status === 201) {
        const lines = db.onlyCallTo('insert', 'orderItems').values as unknown[];
        assert.equal(lines.length, 1);
      } else {
        assert.equal(h.audits.length, 0);
      }
    } finally { await h.close(); }
  }
});

test('available partial-cost recipes use known cost without markup and preserve incomplete provenance', async () => {
  const db = database();
  db.prepend('select', 'recipeIngredients', [
    { recipeId, quantity: '1', averageUnitCost: '2' },
    { recipeId, quantity: '1', averageUnitCost: null },
  ]);
  const h = await buildNestOrdersApp('owner', db as never);
  try {
    const result = await request(h.app.getHttpServer()).post('/api/v1/orders').set(headers)
      .send({ ...input, items: [{ recipeId, quantity: 1, expectedUnitPrice: '2.00' }] });
    assert.equal(result.status, 201, result.text);
    assert.equal(result.body.totals.totalAmount, 2);
    const lines = db.onlyCallTo('insert', 'orderItems').values as { costComplete: boolean; unitCost: string }[];
    assert.equal(lines[0]?.costComplete, false);
    assert.equal(lines[0]?.unitCost, '2.00');
  } finally { await h.close(); }
});

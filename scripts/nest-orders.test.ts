import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { OrdersPersistence } from '../src/modules/orders/orders.persistence.js';
import { OrdersAudit } from '../src/modules/orders/orders.audit.js';
import { createOrderSchema } from '../src/modules/orders/contracts.js';
import { actorFor } from './support/nestOrdersApp.js';
test('create input rejects fractional quantity and strips caller supplied lifecycle', () => {
  assert.throws(() => createOrderSchema.parse({ items: [{ recipeId: '44444444-4444-4444-4444-444444444444', quantity: 1.5 }] }));
  const body = createOrderSchema.parse({ status: 'delivered', items: [{ recipeId: '44444444-4444-4444-4444-444444444444', quantity: 1 }] });
  assert.equal('status' in body, false);
});
test('business service refuses member mutations before touching persistence', async () => {
  const repository = new OrdersPersistence({} as never);
  const service = new OrdersService(repository, new OrdersAudit());
  await assert.rejects(service.cancel(actorFor('member'), '44444444-4444-4444-4444-444444444444'), { statusCode: 403 });
  await assert.rejects(service.create(actorFor('member'), { items: [], deliveryDistanceKm: 0 }), { statusCode: 403 });
});
import request from 'supertest';
import { FakeDb } from './support/fakeDb.js';
import { buildNestOrdersApp, SHOP_ID, USER_ID } from './support/nestOrdersApp.js';
import type { Order } from '../src/db/schema/orders.js';
const ORDER_ID = '44444444-4444-4444-4444-444444444444';
const RECIPE_ID = '11111111-1111-1111-1111-111111111111';
const storedOrder: Order = {
  id: ORDER_ID, orderNumber: 1, shopId: SHOP_ID, userId: USER_ID, customerName: 'Dana', orderDate: new Date('2026-01-01T00:00:00Z'), destinationAddress: null, deliveryDistanceKm: '0.00', deliveryFee: '5.00', appliedProfitMargin: '30.00', totalCost: '4.00', totalAmount: '15.00', documentUrl: null, status: 'processing', createdAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null
};
const auth = { authorization: 'Bearer test', 'x-shop-id': SHOP_ID };
function pricingResponses() { return { 'select:recipes': [[{
        id: RECIPE_ID, name: 'Focaccia', prepTimeMinutes: 0, yieldQuantity: '1', targetMarginPct: null
      }]], 'select:recipeIngredients': [[{
        recipeId: RECIPE_ID, quantity: '1', averageUnitCost: '2.00'
      }]] }; }
test('Nest orders preserves list/detail strings, dates, snapshot names and explicit output mapping', async () => {
  const fake = new FakeDb({
    'select:orders': [[{ ...storedOrder, privateColumn: 'secret' }], [{ count: 1 }], [storedOrder]], 'select:orderItems': [[{
          id: RECIPE_ID, recipeId: RECIPE_ID, name: 'Frozen name', quantity: '2.000', unitCost: '2.00', unitPrice: '5.00'
        }]], 'select:mediaUploads': [[{ sources: [] }]]
  });
  const h = await buildNestOrdersApp('member', fake as never);
  try {
    const list = await request(h.app.getHttpServer()).get('/api/v1/orders?status=processing').set(auth);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.orders[0].netProfit, 6);
    assert.equal(list.body.orders[0].totalAmount, '15.00');
    assert.equal(list.body.orders[0].orderDate, '2026-01-01T00:00:00.000Z');
    assert.equal('privateColumn' in list.body.orders[0], false);
    const detail = await request(h.app.getHttpServer()).get(`/api/v1/orders/${ORDER_ID}`).set(auth);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.order.items[0].name, 'Frozen name');
  }
  finally {
    await h.close();
  }
});
test('Nest quote and create preserve pricing and force processing with transactional invoice numbering', async () => {
  const fake = new FakeDb({
    ...pricingResponses(), 'update:shops': [[{ lastOrderNumber: 1 }]], 'insert:orders': [[storedOrder]], 'insert:orderItems': [[]]
  });
  const h = await buildNestOrdersApp('owner', fake as never);
  try {
    const created = await request(h.app.getHttpServer()).post('/api/v1/orders').set(auth).send({ status: 'delivered', items: [{
          recipeId: RECIPE_ID, quantity: 2, unitPrice: 5
        }] });
    assert.equal(created.status, 201);
    assert.equal(created.body.order.status, 'processing');
    assert.equal(created.body.totals.totalAmount, 15);
    assert.equal(h.audits.length, 1);
    assert.equal((fake.onlyCallTo('insert', 'orders').values as {
      status: string;
    }).status, 'processing');
    assert.equal((fake.onlyCallTo('insert', 'orderItems').values as {
      recipeName: string;
    }[])[0]?.recipeName, 'Focaccia');
    h.use({ db: new FakeDb(pricingResponses()) as never });
    const quote = await request(h.app.getHttpServer()).post('/api/v1/orders/quote').set(auth).send({ deliveryDistanceKm: 2, items: [{
          recipeId: RECIPE_ID, quantity: 2, unitPrice: 5
        }] });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.deliveryFee, 8);
    assert.equal(quote.body.totalAmount, 18);
  }
  finally {
    await h.close();
  }
});
test('Nest verify enforces terminal and compare-and-set errors; cancel remains idempotent', async () => {
  const fake = new FakeDb({ 'select:orders': [[storedOrder], [{ ...storedOrder, status: 'delivered' }], [storedOrder], [{ id: ORDER_ID, status: 'processing' }], [{ id: ORDER_ID, status: 'cancelled' }]], 'update:orders': [[{ ...storedOrder, status: 'delivered' }], [], [{ id: ORDER_ID }]] });
  const h = await buildNestOrdersApp('owner', fake as never);
  try {
    const server = h.app.getHttpServer();
    assert.equal((await request(server).post(`/api/v1/orders/${ORDER_ID}/verify`).set(auth)).status, 200);
    assert.equal((await request(server).post(`/api/v1/orders/${ORDER_ID}/verify`).set(auth)).status, 400);
    assert.equal((await request(server).post(`/api/v1/orders/${ORDER_ID}/verify`).set(auth)).status, 409);
    assert.equal((await request(server).delete(`/api/v1/orders/${ORDER_ID}`).set(auth)).status, 200);
    assert.equal((await request(server).delete(`/api/v1/orders/${ORDER_ID}`).set(auth)).status, 200);
    assert.deepEqual(h.audits.map(audit => audit.eventType), ['ORDER_DELIVERED', 'ORDER_CANCELLED']);
  }
  finally {
    await h.close();
  }
});
test('Nest order authorization, missing resources and input validation have stable statuses', async () => {
  const h = await buildNestOrdersApp('member', new FakeDb({ 'select:orders': [[]] }) as never);
  try {
    const server = h.app.getHttpServer();
    assert.equal((await request(server).get('/api/v1/orders')).status, 401);
    assert.equal((await request(server).get('/api/v1/orders').set({ ...auth, 'x-shop-id': USER_ID })).status, 403);
    assert.equal((await request(server).get('/api/v1/orders/not-id').set(auth)).status, 400);
    assert.equal((await request(server).get(`/api/v1/orders/${ORDER_ID}`).set(auth)).status, 404);
    assert.equal((await request(server).delete(`/api/v1/orders/${ORDER_ID}`).set(auth)).status, 403);
    assert.equal((await request(server).post('/api/v1/orders').set(auth).send({ items: [{ recipeId: RECIPE_ID, quantity: 1 }] })).status, 403);
    assert.equal((await request(server).post('/api/v1/orders/quote').set(auth).send({ items: [{ recipeId: RECIPE_ID, quantity: 1.5 }] })).status, 400);
  }
  finally {
    await h.close();
  }
});

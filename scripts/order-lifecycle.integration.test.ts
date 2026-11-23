import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { AnalyticsPersistence } from '../src/modules/analytics/analytics.persistence.js';
import { TEST_SHOP } from './support/nestOrdersApp.js';
import { buildSyncApplication } from './support/syncApp.js';

test('cancellation removes a sale once and recording the refund or undoing delivery preserves reporting', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const deliveredId = randomUUID();
  const legacyId = randomUUID();
  const recipeId = randomUUID();
  const lineId = randomUUID();
  const shop = { ...TEST_SHOP, id: shopId, slug: shopId };
  const owner = await buildSyncApplication(database, shop, userId);
  const admin = await buildSyncApplication(database, shop, userId, 'admin');
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  const occurredAt = '2026-11-23T10:00:00.000Z';
  const date = new Date(occurredAt);
  const analytics = new AnalyticsPersistence({ db: database, now: () => date });
  const dashboard = () => analytics.dashboard(shopId, '30d');
  const path = (id: string) => `/api/v1/orders/${id}`;
  const snapshot = async (id = orderId, client = owner) => {
    const response = await client.inject({ method: 'GET', url: path(id),
      headers: { ...headers, 'x-sync-snapshot': 'true' } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const mutate = async (id: string, route: string, base: number, payload: object, syncId = randomUUID()) => {
    const response = await owner.inject({ method: route ? 'POST' : 'PATCH', url: path(id) + route, payload,
      headers: { ...headers, 'x-sync-id': syncId, 'x-sync-base-version': String(base), 'x-sync-version': String(base + 100) } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  try {
    await database.insert(schema.users).values({ id: userId, email: `${userId}@example.test`, passwordHash: 'fixture' });
    await database.insert(schema.shops).values(shop);
    await database.insert(schema.recipes).values({ id: recipeId, shopId, name: 'Honey Cake' });
    await database.insert(schema.orders).values([
      { id: orderId, shopId, orderNumber: 1, orderDate: date, status: 'processing',
        totalAmount: '200.00', totalCost: '80.00', deliveryFee: '10.00' },
      { id: deliveredId, shopId, orderNumber: 2, orderDate: date, status: 'delivered',
        totalAmount: '100.00', totalCost: '40.00', deliveryFee: '5.00' },
      { id: legacyId, shopId, orderNumber: 3, orderDate: date, status: 'cancelled', totalAmount: '999.00' },
    ]);
    await database.insert(schema.orderItems).values({ id: lineId, orderId, shopId, recipeId,
      recipeName: 'Honey Cake', quantity: '10.000', unitPrice: '19.00', unitCost: '8.00', costComplete: true });
    await database.insert(schema.orderPayments).values({ orderId: deliveredId, kind: 'payment', amount: '100.00', occurredAt: date });
    const legacy = await snapshot(legacyId);
    assert.deepEqual(legacy.order.paymentHistory, []);
    assert.equal(legacy.order.cancellationMadeItems, null);

    const start = await snapshot();
    const deposit = await mutate(orderId, '/payments', start.syncVersion, { kind: 'deposit', amount: '50.00', occurredAt });
    const paid = await mutate(orderId, '/payments', deposit.syncVersion, { kind: 'payment', amount: '150.00', occurredAt });
    const edited = await mutate(orderId, '', paid.syncVersion, { deliveryFee: '50.00', items: [{ lineId, quantity: 10 }] });
    assert.equal(edited.order.totalAmount, '240.00');
    assert.equal(edited.order.paymentSummary.balanceDue, '40.00');
    assert.deepEqual(edited.order.paymentHistory, paid.order.paymentHistory);
    const beforeCancel = await dashboard();
    assert.equal(beforeCancel.summary.revenue, 340);
    assert.equal(beforeCancel.summary.netProfit, 165);
    assert.equal(beforeCancel.summary.orderCount, 2);

    const olderClient = await admin.inject({ method: 'DELETE', url: path(orderId), headers });
    assert.equal(olderClient.statusCode, 409);
    assert.match(olderClient.body, /Reload the app/);
    assert.deepEqual(await snapshot(orderId, admin), edited);

    const decision = { madeItems: true, stockItems: [{ orderItemId: lineId, quantity: 6 }] };
    const cancelKey = randomUUID();
    const canceled = await mutate(orderId, '/cancel', edited.syncVersion, decision, cancelKey);
    assert.equal(canceled.outcome, 'cancelled');
    assert.equal(canceled.order.paymentSummary.refundDue, '200.00');
    assert.equal(canceled.stockAdded.length, 1);
    assert.equal(canceled.stockAdded[0].quantityAdded, 6);
    assert.deepEqual(await mutate(orderId, '/cancel', edited.syncVersion, decision, cancelKey), canceled);
    const afterCancel = await dashboard();
    assert.equal(afterCancel.summary.revenue, 100);
    assert.equal(afterCancel.summary.netProfit, 55);
    assert.equal(afterCancel.summary.orderCount, 1);

    const refundKey = randomUUID();
    const refunded = await mutate(orderId, '/refund', canceled.syncVersion, { occurredAt }, refundKey);
    assert.equal(refunded.order.paymentSummary.status, 'refunded');
    assert.deepEqual(refunded.order.paymentHistory.filter((row: { kind: string }) => row.kind === 'refund')
      .map((row: { amount: string }) => row.amount), ['200.00']);
    assert.deepEqual(await mutate(orderId, '/refund', canceled.syncVersion, { occurredAt }, refundKey), refunded);
    assert.deepEqual(await snapshot(orderId, admin), refunded);
    assert.deepEqual(await dashboard(), afterCancel);

    const delivered = await snapshot(deliveredId);
    const undone = await mutate(deliveredId, '/undo-delivery', delivered.syncVersion, { confirmedMarkedByMistake: true });
    assert.deepEqual(undone.order, { ...delivered.order, status: 'processing' });
    assert.deepEqual(await dashboard(), afterCancel);
    const stock = await connection`SELECT quantity_added, quantity_remaining FROM finished_stock WHERE shop_id = ${shopId}`;
    assert.deepEqual([...stock], [{ quantity_added: 6, quantity_remaining: 6 }]);
  } finally {
    await Promise.all([owner.close(), admin.close()]);
    await connection`DELETE FROM finished_stock WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM order_payments WHERE order_id IN (${orderId}, ${deliveredId})`;
    await connection`DELETE FROM order_items WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM shops WHERE id = ${shopId}`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

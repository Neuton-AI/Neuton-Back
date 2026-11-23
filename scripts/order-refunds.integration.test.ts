import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { TEST_SHOP } from './support/nestOrdersApp.js';
import { buildSyncApplication } from './support/syncApp.js';

test('records the full refund once from received money and publishes the updated order', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const foreignShopId = randomUUID();
  const userId = randomUUID();
  const shop = { ...TEST_SHOP, id: shopId, slug: shopId };
  const orderId = randomUUID();
  const unpaidId = randomUUID();
  const deliveredId = randomUUID();
  const processingId = randomUUID();
  const foreignId = randomUUID();
  const owner = await buildSyncApplication(database, shop, userId);
  const admin = await buildSyncApplication(database, shop, userId, 'admin');
  const member = await buildSyncApplication(database, shop, userId, 'member');
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  const occurredAt = '2026-11-21T12:00:00+02:00';
  const snapshot = async (id = orderId) => {
    const response = await owner.inject({ method: 'GET', url: `/api/v1/orders/${id}`,
      headers: { ...headers, 'x-sync-snapshot': 'true' } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const refund = (expected: number, { app = admin, id = orderId, syncId = randomUUID(),
    payload = { occurredAt } as Record<string, unknown> } = {}) => app.inject({
    method: 'POST', url: `/api/v1/orders/${id}/refund`, payload,
    headers: { ...headers, 'x-sync-id': syncId, 'x-sync-base-version': String(expected),
      'x-sync-version': String(expected + 10) },
  });

  try {
    await database.insert(schema.users).values({ id: userId, email: `${userId}@example.test`, passwordHash: 'fixture' });
    await database.insert(schema.shops).values([shop, { id: foreignShopId, slug: foreignShopId, name: 'Other shop' }]);
    await database.insert(schema.orders).values([
      { id: orderId, shopId, orderNumber: 1, status: 'cancelled', totalAmount: '240.00' },
      { id: unpaidId, shopId, orderNumber: 2, status: 'cancelled', totalAmount: '50.00' },
      { id: deliveredId, shopId, orderNumber: 3, status: 'delivered', totalAmount: '50.00' },
      { id: processingId, shopId, orderNumber: 4, status: 'processing', totalAmount: '50.00' },
      { id: foreignId, shopId: foreignShopId, orderNumber: 1, status: 'cancelled', totalAmount: '50.00' },
    ]);
    await database.insert(schema.orderPayments).values([
      { orderId, kind: 'deposit', amount: '50.00', occurredAt: new Date('2026-11-01') },
      { orderId, kind: 'payment', amount: '150.00', occurredAt: new Date('2026-11-10') },
    ]);
    const before = await snapshot();
    const base: number = before.syncVersion;
    assert.equal(before.order.paymentSummary.refundDue, '200.00');
    assert.equal((await refund(base, { app: member })).statusCode, 403);
    assert.equal((await refund(base, { id: foreignId })).statusCode, 404);
    assert.equal((await refund(base, { payload: { occurredAt, amount: '1.00' } })).statusCode, 400);
    assert.equal((await refund(base, { payload: { occurredAt: '2026-02-30' } })).statusCode, 400);
    for (const id of [unpaidId, deliveredId, processingId]) {
      const ineligible = await snapshot(id);
      assert.equal((await refund(ineligible.syncVersion, { id })).statusCode, 409);
    }

    const requests = [randomUUID(), randomUUID()];
    const responses = await Promise.all(requests.map(syncId => refund(base, { syncId })));
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
    const successIndex = responses.findIndex(response => response.statusCode === 200);
    const successful = responses[successIndex];
    assert.ok(successful);
    const result = successful.json();
    const syncId = requests[successIndex];
    assert.equal(result.syncVersion, base + 10);
    assert.equal(result.order.status, 'cancelled');
    assert.equal(result.order.paymentSummary.status, 'refunded');
    assert.equal(result.order.paymentSummary.refundDue, '0.00');
    assert.equal(result.order.paymentSummary.totalReceived, '200.00');
    assert.deepEqual(result.order.paymentHistory.slice(0, 2), before.order.paymentHistory);
    const completed = result.order.paymentHistory[2];
    assert.equal(completed.kind, 'refund');
    assert.equal(completed.amount, '200.00');
    assert.equal(completed.recordedByUserId, userId);
    assert.equal(completed.occurredAt, '2026-11-21T10:00:00.000Z');
    assert.deepEqual(await snapshot(), result);
    assert.deepEqual((await refund(base, { syncId })).json(), result);
    assert.equal((await refund(base, { syncId, payload: { occurredAt: '2026-11-22T12:00:00+02:00' } })).statusCode, 409);
    assert.equal((await refund(result.syncVersion)).statusCode, 409);
    const stored = await database.select().from(schema.orderPayments).where(eq(schema.orderPayments.orderId, orderId));
    assert.equal(stored.filter(payment => payment.kind === 'refund').length, 1);
  } finally {
    await Promise.all([owner.close(), admin.close(), member.close()]);
    await connection`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await connection`DELETE FROM shops WHERE id IN (${shopId}, ${foreignShopId})`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

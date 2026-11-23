import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { TEST_SHOP } from './support/nestOrdersApp.js';
import { buildSyncApplication } from './support/syncApp.js';

test('records versioned deposits and payments once and rejects stale or ineligible writes', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const otherShopId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const deliveredId = randomUUID();
  const foreignId = randomUUID();
  const shop = { ...TEST_SHOP, id: shopId, slug: shopId };
  const owner = await buildSyncApplication(database, shop, userId);
  const admin = await buildSyncApplication(database, shop, userId, 'admin');
  const member = await buildSyncApplication(database, shop, userId, 'member');
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  const snapshot = async (id = orderId, app = owner) => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}`,
      headers: { ...headers, 'x-sync-snapshot': 'true' } });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  try {
    await database.insert(schema.users).values({ id: userId, email: `${userId}@example.test`, passwordHash: 'fixture' });
    await database.insert(schema.shops).values([shop, { id: otherShopId, name: 'Other shop', slug: otherShopId }]);
    await database.insert(schema.orders).values([
      { id: orderId, shopId, orderNumber: 1, status: 'processing', totalAmount: '200.00' },
      { id: deliveredId, shopId, orderNumber: 2, status: 'delivered', totalAmount: '200.00' },
      { id: foreignId, shopId: otherShopId, orderNumber: 1, status: 'processing', totalAmount: '200.00' },
    ]);
    const initial = await snapshot();
    const base: number = initial.syncVersion;
    const deposit = { kind: 'deposit', amount: '50.00', occurredAt: '2026-11-21T12:00:00+02:00' };
    const record = ({ app = owner, id = orderId, syncId = randomUUID(), expected = base,
      payload = deposit }: { app?: typeof owner; id?: string; syncId?: string; expected?: number;
      payload?: { kind: string; amount: string; occurredAt: string } } = {}) => app.inject({
      method: 'POST', url: `/api/v1/orders/${id}/payments`, payload,
      headers: { ...headers, 'x-sync-id': syncId, 'x-sync-base-version': String(expected),
        'x-sync-version': String(expected + 10) },
    });
    const syncId = randomUUID();
    const first = await record({ syncId });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().order.paymentSummary.balanceDue, '150.00');
    assert.equal(first.json().order.paymentHistory[0].recordedByUserId, userId);
    assert.equal(first.json().order.paymentHistory[0].occurredAt, '2026-11-21T10:00:00.000Z');
    assert.deepEqual((await record({ syncId })).json(), first.json());
    assert.deepEqual(await snapshot(orderId, admin), first.json());

    const current: number = first.json().syncVersion;
    assert.equal(current, base + 10);
    assert.equal((await record()).statusCode, 409);
    assert.equal((await record({ syncId, payload: { ...deposit, amount: '49.00' } })).statusCode, 409);
    assert.equal((await record({ app: member, expected: current })).statusCode, 403);
    assert.equal((await record({ id: foreignId })).statusCode, 404);
    const delivered = await snapshot(deliveredId);
    assert.equal((await record({ id: deliveredId, expected: delivered.syncVersion })).statusCode, 409);
    for (const invalid of [{ amount: '0.00' }, { amount: '0.001' }, { kind: 'refund' }, { occurredAt: '2026-02-30' }]) {
      assert.equal((await record({ payload: { ...deposit, ...invalid }, expected: current })).statusCode, 400);
    }
    assert.equal((await record({ payload: { ...deposit, amount: '150.01' }, expected: current })).statusCode, 409);

    const balance = { ...deposit, kind: 'payment', amount: '150.00' };
    const results = await Promise.all([
      record({ app: admin, payload: balance, expected: current }),
      record({ payload: balance, expected: current }),
    ]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    const paid = await snapshot();
    assert.equal(paid.order.paymentSummary.status, 'paid');
    assert.equal(paid.order.paymentSummary.totalReceived, '200.00');
    assert.equal(paid.order.paymentHistory.length, 2);
    assert.equal(paid.order.status, 'processing');

    await connection`UPDATE orders SET total_amount = '240.00' WHERE id = ${orderId}`;
    const edited = await snapshot();
    assert.equal(edited.order.paymentSummary.balanceDue, '40.00');
    assert.deepEqual(edited.order.paymentHistory, paid.order.paymentHistory);
  } finally {
    await Promise.all([owner.close(), admin.close(), member.close()]);
    await connection`DELETE FROM order_payments WHERE order_id = ${orderId}`;
    await connection`DELETE FROM shops WHERE id IN (${shopId}, ${otherShopId})`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

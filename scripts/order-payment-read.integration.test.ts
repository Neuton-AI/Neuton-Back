import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { TEST_SHOP } from './support/nestOrdersApp.js';
import { buildSyncApplication } from './support/syncApp.js';

test('order list, detail, and sync snapshots agree on payment state and preserve legacy history', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const otherShopId = randomUUID();
  const shop = { ...TEST_SHOP, id: shopId, slug: shopId };
  const app = await buildSyncApplication(database, shop, randomUUID(), 'member');
  const paid = randomUUID();
  const cancelled = randomUUID();
  const legacy = randomUUID();
  const zero = randomUUID();
  const foreign = randomUUID();
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  try {
    await connection`INSERT INTO shops (id, name, slug) VALUES (${shopId}, 'Payment reads', ${shopId}), (${otherShopId}, 'Other shop', ${otherShopId})`;
    await connection`INSERT INTO orders (id, shop_id, order_number, total_amount, status) VALUES
      (${paid}, ${shopId}, 1, 200, 'processing'), (${cancelled}, ${shopId}, 2, 200, 'cancelled'),
      (${legacy}, ${shopId}, 3, 21.15, 'delivered'), (${zero}, ${shopId}, 4, 0, 'processing'),
      (${foreign}, ${otherShopId}, 1, 90, 'delivered')`;
    await connection`INSERT INTO order_payments (order_id, kind, amount, occurred_at) VALUES
      (${paid}, 'payment', 150, '2026-11-22T12:00:00Z'), (${paid}, 'deposit', 50, '2026-11-21T12:00:00Z'),
      (${cancelled}, 'deposit', 10.01, '2026-11-21T12:00:00Z'), (${foreign}, 'payment', 90, '2026-11-22T12:00:00Z')`;

    const list = await app.inject({ method: 'GET', url: '/api/v1/orders', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().total, 4);
    const expected = [[paid, 'paid'], [cancelled, 'pending_refund'], [legacy, 'unpaid'], [zero, 'paid']];
    for (const [id, status] of expected) {
      const url = `/api/v1/orders/${id}`;
      const summaryFromList = list.json().orders.find((order: { id: string }) => order.id === id);
      assert.equal(summaryFromList.paymentSummary.status, status);
      assert.equal('paymentHistory' in summaryFromList, false);
      const detail = await app.inject({ method: 'GET', url, headers });
      assert.equal(detail.statusCode, 200);
      const { order } = detail.json();
      assert.deepEqual(order.paymentSummary, summaryFromList.paymentSummary);
      const snapshot = await app.inject({ method: 'GET', url, headers: { ...headers, 'x-sync-snapshot': 'true' } });
      assert.equal(snapshot.statusCode, 200);
      assert.ok(snapshot.json().syncVersion > 0);
      assert.deepEqual(snapshot.json().order, order);
      if (id === legacy) assert.deepEqual(order.paymentHistory, []);
      if (id === paid) assert.deepEqual(order.paymentHistory.map((row: { kind: string }) => row.kind), ['deposit', 'payment']);
      if (id === cancelled) assert.equal(order.paymentSummary.refundDue, '10.01');
    }
    const outOfScope = await app.inject({ method: 'GET', url: `/api/v1/orders/${foreign}`, headers });
    assert.equal(outOfScope.statusCode, 404);
  } finally {
    await app.close();
    await connection`DELETE FROM order_payments WHERE order_id IN (${paid}, ${cancelled}, ${foreign})`;
    await connection`DELETE FROM shops WHERE id IN (${shopId}, ${otherShopId})`;
    await connection.end();
  }
});

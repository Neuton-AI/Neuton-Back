import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { TEST_SHOP } from './support/nestOrdersApp.js';
import { buildSyncApplication } from './support/syncApp.js';

test('cancellation syncs both outcomes, rejects stale decisions, and replays a deleted order', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const userId = randomUUID();
  const recipe = randomUUID();
  const line = randomUUID();
  const editLine = randomUUID();
  const deleted = randomUUID();
  const retained = randomUUID();
  const paid = randomUUID();
  const edited = randomUUID();
  const delivered = randomUUID();
  const racing = randomUUID();
  const racingDelivery = randomUUID();
  const shop = { ...TEST_SHOP, id: shopId, slug: shopId };
  const app = await buildSyncApplication(database, shop, userId);
  const member = await buildSyncApplication(database, shop, userId, 'member');
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  const url = (id: string) => `/api/v1/orders/${id}`;
  const snapshot = (id: string, actor = app) => actor.inject({ method: 'GET', url: url(id), headers: { ...headers, 'x-sync-snapshot': 'true' } });
  const version = async (id: string) => {
    const response = await snapshot(id);
    assert.equal(response.statusCode, 200);
    return response.json().syncVersion as number;
  };
  const mutate = (id: string, path: string, base: number, payload: object, mutationId = randomUUID(), actor = app) => actor.inject({
    method: path ? 'POST' : 'PATCH', url: `${url(id)}${path}`, payload,
    headers: { ...headers, 'x-sync-id': mutationId, 'x-sync-base-version': String(base), 'x-sync-version': String(base + 100) },
  });
  const nothingMade = { madeItems: false, stockItems: [] };
  const stock = { madeItems: true, stockItems: [{ orderItemId: line, quantity: 2 }] };
  const payment = { kind: 'deposit', amount: '50.00', occurredAt: '2026-11-23T10:00:00.000Z' };
  try {
    await database.insert(schema.users).values({ id: userId, email: `${userId}@example.test`, passwordHash: 'fixture' });
    await database.insert(schema.shops).values(shop);
    await database.insert(schema.recipes).values({ id: recipe, shopId, name: 'Cake', isActive: false });
    await database.insert(schema.orders).values([deleted, retained, paid, edited, delivered, racing, racingDelivery].map((id, i) => ({
      id, shopId, orderNumber: i + 1, customerName: 'Saved customer', totalAmount: '200.00',
    })));
    await database.insert(schema.orderItems).values([{ id: line, orderId: retained }, { id: editLine, orderId: edited }]
      .map(value => ({ ...value, shopId, recipeId: recipe, recipeName: 'Saved cake', quantity: '2.750', unitCost: '18.73' })));

    const deletedBase = await version(deleted);
    const requestId = randomUUID();
    assert.equal((await mutate(deleted, '/cancel', deletedBase, nothingMade, randomUUID(), member)).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${url(deleted)}/cancel`, headers, payload: nothingMade })).statusCode, 400);
    const gone = await mutate(deleted, '/cancel', deletedBase, nothingMade, requestId);
    assert.equal(gone.statusCode, 200, gone.body);
    assert.deepEqual(gone.json(), { outcome: 'deleted', orderId: deleted });
    assert.deepEqual((await mutate(deleted, '/cancel', deletedBase, nothingMade, requestId)).json(), gone.json());
    assert.equal((await mutate(deleted, '/cancel', deletedBase, { ...nothingMade, madeItems: true }, requestId)).statusCode, 409);
    assert.equal((await mutate(deleted, '/cancel', deletedBase, nothingMade)).statusCode, 404);

    const retainedBase = await version(retained);
    assert.equal((await mutate(retained, '/cancel', retainedBase, { ...stock, madeItems: false })).statusCode, 400);
    assert.equal((await mutate(retained, '/cancel', retainedBase, { madeItems: true,
      stockItems: [{ orderItemId: editLine, quantity: 1 }] })).statusCode, 400);
    const kept = await mutate(retained, '/cancel', retainedBase, stock);
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(kept.json().order.items[0].name, 'Saved cake');
    assert.equal(kept.json().stockAdded[0].quantityAdded, 2);
    assert.equal(kept.json().order.cancellationMadeItems, true);
    const remote = await snapshot(retained, member);
    assert.deepEqual(remote.json(), { order: kept.json().order, syncVersion: retainedBase + 100 });
    const sync = await member.inject({ method: 'POST', url: '/api/v1/sync/check', headers, payload: { documents: [
      { id: deleted, kind: 'order', updatedAt: deletedBase }, { id: retained, kind: 'order', updatedAt: retainedBase },
    ] } });
    assert.equal(sync.statusCode, 200);
    assert.ok(sync.json().toPull.some((row: { id: string; deleted: boolean }) => row.id === deleted && row.deleted));
    assert.ok(sync.json().toPull.some((row: { id: string; deleted: boolean }) => row.id === retained && !row.deleted));

    const paidBase = await version(paid);
    assert.equal((await mutate(paid, '/payments', paidBase, payment)).statusCode, 200);
    assert.equal((await mutate(paid, '/cancel', paidBase, nothingMade)).statusCode, 409);
    const refundDue = await mutate(paid, '/cancel', await version(paid), nothingMade);
    assert.equal(refundDue.json().order.paymentSummary.refundDue, '50.00');
    const editedBase = await version(edited);
    const edit = await mutate(edited, '', editedBase, { deliveryFee: '40.00', items: [{ lineId: editLine, quantity: 2.75 }] });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal((await mutate(edited, '/cancel', editedBase, nothingMade)).statusCode, 409);
    const deliveredBase = await version(delivered);
    assert.equal((await mutate(delivered, '/verify', deliveredBase, {})).statusCode, 200);
    assert.equal((await mutate(delivered, '/cancel', deliveredBase, nothingMade)).statusCode, 409);
    assert.equal((await mutate(delivered, '/cancel', await version(delivered), nothingMade)).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: url(delivered), headers })).statusCode, 409);
    assert.equal((await snapshot(delivered)).json().order.status, 'delivered');

    const racingBase = await version(racing);
    const [payRace, cancelRace] = await Promise.all([
      mutate(racing, '/payments', racingBase, payment), mutate(racing, '/cancel', racingBase, nothingMade),
    ]);
    if (payRace.statusCode === 200) {
      assert.equal(cancelRace.statusCode, 409);
      assert.equal((await snapshot(racing)).json().order.paymentSummary.totalReceived, '50.00');
    } else {
      assert.equal(payRace.statusCode, 404);
      assert.equal(cancelRace.json().outcome, 'deleted');
    }

    const editRaceBase = await version(edited);
    const [editRace, editCancelRace] = await Promise.all([
      mutate(edited, '', editRaceBase, { deliveryFee: '15.00', items: [{ lineId: editLine, quantity: 2.75 }] }),
      mutate(edited, '/cancel', editRaceBase, { madeItems: true, stockItems: [] }),
    ]);
    assert.deepEqual([editRace.statusCode, editCancelRace.statusCode].sort(), [200, 409]);
    const afterEditRace = (await snapshot(edited)).json().order;
    assert.equal(afterEditRace.status, editRace.statusCode === 200 ? 'processing' : 'cancelled');
    assert.equal(afterEditRace.deliveryFee, editRace.statusCode === 200 ? '15.00' : '40.00');

    const deliveryRaceBase = await version(racingDelivery);
    const [deliveryRace, deliveryCancelRace] = await Promise.all([
      mutate(racingDelivery, '/verify', deliveryRaceBase, {}),
      mutate(racingDelivery, '/cancel', deliveryRaceBase, { madeItems: true, stockItems: [] }),
    ]);
    if (deliveryCancelRace.statusCode === 200) assert.equal(deliveryRace.json().syncConflict, true);
    else assert.equal(deliveryCancelRace.statusCode, 409);
    assert.equal((await snapshot(racingDelivery)).json().order.status,
      deliveryCancelRace.statusCode === 200 ? 'cancelled' : 'delivered');
  } finally {
    await Promise.all([app.close(), member.close()]);
    await connection`DELETE FROM finished_stock WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM order_payments WHERE order_id IN (${paid}, ${racing})`;
    await connection`DELETE FROM order_items WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM shops WHERE id = ${shopId}`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adjustInventory } from '../src/lib/inventoryAdjustments.js';
import { inventoryItems, shopMembers, inventoryAdjustmentBatches } from '../src/db/schema/index.js';
import { withShopTransaction } from '../src/db/tenant-context.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { buildSyncApplication } from './support/syncApp.js';

test('stock batches rollback, serialize retries, reject payload reuse and foreign IDs', { skip: neonTestSkip, timeout: 90_000 }, async () => {
  const f = await neonFixture();
  let other: Awaited<ReturnType<typeof neonFixture>> | undefined;
  let app: Awaited<ReturnType<typeof buildSyncApplication>> | undefined;
  const first = randomUUID(), second = randomUUID(), foreign = randomUUID();
  const constraint = `adjustment_test_${randomUUID().replaceAll('-', '')}`;
  try {
    other = await neonFixture();
    await f.admin.insert(shopMembers).values({ shopId: f.shopId, userId: other.userId, role: 'admin' });
    for (const [id, shopId] of [[first, f.shopId], [second, f.shopId], [foreign, other.shopId]] as const) {
      await f.admin.insert(inventoryItems).values({ id, shopId, name: `Fixture ${id}`, rawMaterialName: id,
        unit: 'g', baseUnit: 'g', baseUnitAmount: '10', baseUnitCost: '1', currentQuantity: '10' });
    }
    await f.ownerConnection.unsafe(`alter table public.inventory_items add constraint ${constraint}
      check(id<>'${second}'::uuid or current_quantity<>13) not valid`);
    const client = await buildSyncApplication(f.application, f.shop, f.userId, 'owner', { id: f.sessionId, secret: f.secret });
    app = client;
    const send = (adjustments: { inventoryItemId: string; deltaQuantity: number }[], key = randomUUID()) =>
      client.inject({ method: 'POST', url: '/api/v1/inventory/adjust', payload: { adjustments }, headers: {
        cookie: `neuton-dev-session=${f.secret}`, 'x-shop-id': f.shopId, 'idempotency-key': key,
      } });
    const amount = async (id: string) => Number((await f.admin.select().from(inventoryItems).where(eq(inventoryItems.id, id)))[0]?.currentQuantity);
    const failed = await send([{ inventoryItemId: first, deltaQuantity: 2 }, { inventoryItemId: second, deltaQuantity: 3 }]);
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(await amount(first), 10, 'a later failure rolls back the first delta');
    assert.equal((await f.admin.select().from(inventoryAdjustmentBatches).where(eq(inventoryAdjustmentBatches.shopId, f.shopId))).length, 0);
    const key = randomUUID();
    const batch = [{ inventoryItemId: first, deltaQuantity: 2 }];
    const [a, b] = await Promise.all([send(batch, key), send(batch, key)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json());
    assert.deepEqual(a.json(), { adjusted: 1, ids: [first] });
    assert.equal(await amount(first), 12, 'concurrent replay applies once');
    assert.equal((await f.admin.select().from(inventoryAdjustmentBatches).where(eq(inventoryAdjustmentBatches.shopId, f.shopId)))[0]?.userId, f.userId);
    assert.equal((await send([{ inventoryItemId: first, deltaQuantity: 4 }], key)).statusCode, 409);
    assert.equal(await amount(first), 12);
    await assert.rejects(withShopTransaction(other.application, other.actor.session, f.shopId, scope =>
      adjustInventory(scope, { shopId: f.shopId, userId: scope.userId, key, adjustments: batch })), { statusCode: 409 });
    assert.equal(await amount(first), 12, 'another user cannot replay the saved result');
    assert.deepEqual(await other.inShop(scope => adjustInventory(scope, { shopId: scope.shopId, userId: scope.userId,
      key, adjustments: [{ inventoryItemId: foreign, deltaQuantity: 2 }] })), { adjusted: 1, ids: [foreign] });
    assert.equal(await amount(foreign), 12, 'another shop has an independent retry namespace');
    assert.equal((await send([{ inventoryItemId: first, deltaQuantity: 1 }, { inventoryItemId: foreign, deltaQuantity: 1 }])).statusCode, 403);
    assert.equal(await amount(first), 12, 'foreign item rejects entire batch');
    assert.equal((await send([...batch, ...batch])).statusCode, 400);
  } finally {
    try {
      await app?.close();
      await f.ownerConnection.unsafe(`alter table public.inventory_items drop constraint if exists ${constraint}`);
    } finally {
      try { await other?.close(); } finally { await f.close(); }
    }
  }
});

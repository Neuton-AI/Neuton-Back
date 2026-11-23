import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { getDatabaseErrorCode } from '../src/lib/dbErrors.js';
import { cancelProcessingOrder } from '../src/modules/orders/order-cancellation.persistence.js';

test('cancellation retains orders with receipts or production and cleans owned files on hard delete', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const orderIds = Array.from({ length: 4 }, () => randomUUID());
  const [unpaid, paid, made, noneSelected] = orderIds as [string, string, string, string];
  const recipe = randomUUID();
  const line = randomUUID();
  const userId = randomUUID();
  const ownPath = `${shopId}/orders/own.jpg`;
  const sharedPath = `${shopId}/orders/shared.jpg`;
  const source = (storagePath: string) => ({ sourceId: randomUUID(), storagePath, contentType: 'image/jpeg', originalFilename: null, byteSize: 42 });
  const cancel = (orderId: string, madeItems: boolean, stockItems: { orderItemId: string; quantity: number }[] = []) =>
    database.transaction(tx => cancelProcessingOrder(tx, { shopId, userId, traceId: 'test', orderId }, { madeItems, stockItems }));
  try {
    await connection`INSERT INTO shops (id, name, slug, last_order_number) VALUES (${shopId}, 'Cancellation', ${shopId}, 4)`;
    await connection`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`})`;
    await database.insert(schema.orders).values(orderIds.map((id, index) => ({ id, shopId, orderNumber: index + 1, totalAmount: '200.00' })));
    await database.insert(schema.recipes).values({ id: recipe, shopId, name: 'Cake renamed', isActive: false });
    await database.insert(schema.orderItems).values({ id: line, shopId, orderId: made, recipeId: recipe,
      quantity: '3.500', unitCost: '12.34', recipeName: 'Original cake', costComplete: false });
    await database.insert(schema.orderPayments).values({ orderId: paid, kind: 'deposit', amount: '50.00', occurredAt: new Date() });
    await database.insert(schema.mediaUploads).values([
      { shopId, orderId: unpaid, kind: 'order', sources: [source(ownPath), source(sharedPath), source('https://example.test/external.jpg')] },
      { shopId, orderId: paid, kind: 'order', sources: [source(sharedPath)] },
    ]);
    await assert.rejects(cancel(unpaid, true, [{ orderItemId: line, quantity: 1 }]), { statusCode: 400 });
    await assert.rejects(cancel(made, true, [{ orderItemId: line, quantity: 4 }]), { statusCode: 400 });
    await assert.rejects(cancel(made, true, [{ orderItemId: line, quantity: 1.5 }]), { statusCode: 400 });
    await assert.rejects(cancel(made, true, [{ orderItemId: line, quantity: 1 }, { orderItemId: line, quantity: 1 }]), { statusCode: 400 });

    await assert.rejects(database.transaction(async tx => {
      // Force the real stock insert to fail after the cancellation update.
      await tx.insert(schema.finishedStock).values({ shopId, recipeId: recipe, sourceOrderItemId: line,
        quantityAdded: 1, quantityRemaining: 1, unitCost: '12.34' });
      return cancelProcessingOrder(tx, { shopId, userId, traceId: 'test', orderId: made }, {
        madeItems: true, stockItems: [{ orderItemId: line, quantity: 3 }],
      });
    }), error => getDatabaseErrorCode(error) === '23505');
    const [unchanged] = await connection`SELECT status, cancelled_at FROM orders WHERE id = ${made}`;
    assert.deepEqual(unchanged, { status: 'processing', cancelled_at: null });

    assert.equal(await cancel(unpaid, false), 'deleted');
    assert.equal(await cancel(paid, false), 'cancelled');
    assert.equal(await cancel(made, true, [{ orderItemId: line, quantity: 3 }]), 'cancelled');
    assert.equal(await cancel(noneSelected, true), 'cancelled');
    const [tombstone] = await connection`SELECT deleted FROM document_versions WHERE id = ${unpaid}`;
    assert.equal(tombstone?.deleted, true);
    const [shop] = await connection`SELECT last_order_number FROM shops WHERE id = ${shopId}`;
    assert.equal(shop?.last_order_number, 4);
    const [kept] = await connection`SELECT status, cancellation_made_items, cancelled_at, cancelled_by_user_id
      FROM orders WHERE id = ${paid}`;
    assert.equal(kept?.status, 'cancelled');
    assert.equal(kept?.cancellation_made_items, false);
    assert.equal(kept?.cancelled_by_user_id, userId);
    assert.ok(kept?.cancelled_at);
    const stock = await connection`SELECT recipe_id, quantity_added, quantity_remaining, unit_cost, cost_complete FROM finished_stock WHERE shop_id = ${shopId}`;
    assert.deepEqual([...stock], [{ recipe_id: recipe, quantity_added: 3, quantity_remaining: 3, unit_cost: '12.34', cost_complete: false }]);
    const stored = await connection`SELECT storage_path FROM storage_object_deletions WHERE shop_id = ${shopId} ORDER BY storage_path`;
    assert.deepEqual(stored.map(row => row.storage_path), [ownPath, `${ownPath}.preview-v1.webp`]);
    assert.equal((await connection`SELECT id FROM media_uploads WHERE order_id = ${paid}`).length, 1);
    assert.equal((await connection`SELECT id FROM order_payments WHERE order_id = ${paid}`).length, 1);
  } finally {
    await connection`DELETE FROM finished_stock WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM storage_object_deletions WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM order_payments WHERE order_id = ${paid}`;
    await connection`DELETE FROM order_items WHERE shop_id = ${shopId}`;
    await connection`DELETE FROM shops WHERE id = ${shopId}`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

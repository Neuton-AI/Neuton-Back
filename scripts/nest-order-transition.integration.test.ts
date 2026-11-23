import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { auditLogs, orders, shops, users } from '../src/db/schema/index.js';
import * as schema from '../src/db/schema/index.js';
import type { Database } from '../src/db/client.js';
import { buildNestOrdersApp, actorFor, SHOP_ID } from './support/nestOrdersApp.js';
import request from 'supertest';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { buildSyncApplication } from './support/syncApp.js';
const databaseUrl = testDatabaseUrl;
const ORDER_ID = '44444444-4444-4444-4444-444444444444';

test('undo delivery is scoped, versioned, audited, and replayable', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const connection = postgres(databaseUrl!);
  const database = drizzle(connection, { schema });
  const shopId = randomUUID();
  const userId = randomUUID();
  const orderId = randomUUID();
  const otherShopId = randomUUID();
  const otherOrderId = randomUUID();
  const shop = { ...actorFor().shop, id: shopId, slug: shopId };
  const owner = await buildSyncApplication(database, shop, userId);
  const member = await buildSyncApplication(database, shop, userId, 'member');
  try {
    await database.insert(users).values({ id: userId, email: `${userId}@example.test`, passwordHash: 'unused-fixture-hash' });
    await database.insert(shops).values({ id: shopId, name: shop.name, slug: shopId });
    await database.insert(shops).values({ id: otherShopId, name: 'Other shop', slug: otherShopId });
    await database.insert(orders).values({ id: otherOrderId, shopId: otherShopId, orderNumber: 1, status: 'delivered' });
    const [before] = await database.insert(orders).values({
      id: orderId, shopId, orderNumber: 1, status: 'delivered',
      totalAmount: '200.00', totalCost: '70.00', deliveryFee: '8.00', deliveryDate: '2026-11-23',
    }).returning();
    const [document] = await database.execute(sql`SELECT updated_at FROM document_versions WHERE id = ${orderId}`);
    const base = Number(document!.updated_at);
    const undo = (options: {
      id?: string; expected?: number; version?: number; payload?: object; app?: typeof owner; target?: string;
    } = {}) => (options.app ?? owner).inject({
      method: 'POST', url: `/api/v1/orders/${options.target ?? orderId}/undo-delivery`,
      headers: {
        cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId,
        'x-sync-id': options.id ?? randomUUID(), 'x-sync-version': String(options.version ?? base + 10),
        'x-sync-base-version': String(options.expected ?? base),
      },
      payload: options.payload ?? { confirmedMarkedByMistake: true },
    });
    assert.equal((await undo({ app: member })).statusCode, 403);
    assert.equal((await undo({ target: otherOrderId })).statusCode, 404);
    assert.equal((await undo({ target: randomUUID() })).statusCode, 404);
    assert.equal((await undo({ payload: {} })).statusCode, 400);
    assert.equal((await undo({ expected: base - 1 })).statusCode, 409);

    const mutationId = randomUUID();
    const success = await undo({ id: mutationId });
    assert.equal(success.statusCode, 200);
    assert.equal(success.json().order.status, 'processing');
    assert.equal(success.json().syncVersion, base + 10);
    assert.deepEqual((await undo({ id: mutationId })).json(), success.json());
    assert.equal((await undo({ id: mutationId, expected: base - 1 })).statusCode, 409);
    assert.equal((await undo({ expected: base + 10, version: base + 20 })).statusCode, 409);
    const [after] = await database.select().from(orders).where(eq(orders.id, orderId));
    assert.deepEqual(after, { ...before, status: 'processing' });
    const audit = await database.select().from(auditLogs).where(eq(auditLogs.resourceId, orderId));
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.eventType, 'ORDER_DELIVERY_UNDONE');
    assert.equal(audit[0]?.userId, userId);
    assert.deepEqual(audit[0]?.metadata, { from: 'delivered', to: 'processing' });
    assert.ok(audit[0]?.createdAt);
  } finally {
    await owner.close();
    await member.close();
    await database.delete(shops).where(eq(shops.id, shopId));
    await database.delete(shops).where(eq(shops.id, otherShopId));
    await database.delete(users).where(eq(users.id, userId));
    await connection.end();
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
// Pause verification after its real SELECT completes. The competing operation
// then commits before verification issues its UPDATE, deterministically exposing
// a stale-read race without sleeps or a query-result fake.
function pauseAfterSelect(target: object, selected: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>): object {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (key === 'then') {
        return (resolve: (rows: unknown) => void, reject: (error: unknown) => void) => {
          Promise.resolve(object).then(async (rows) => {
            selected.resolve();
            await resume.promise;
            return rows;
          }).then(resolve, reject);
        };
      }
      return typeof value === 'function'
        ? (...args: unknown[]) => pauseAfterSelect(value.apply(object, args), selected, resume)
        : value;
    },
  });
}
test('Nest order verification preserves concurrent outcomes and defers effects until outer commit', {
  skip: skipWithoutDisposableDatabase,
  timeout: 20000,
}, async () => {
  const connection = postgres(databaseUrl!, { max: 1 });
  const database = drizzle(connection, { schema });
  const app = await buildNestOrdersApp('owner');
  try {
    // These temporary tables are connection-local and never touch real tables.
    await connection`CREATE TEMP TABLE orders (LIKE public.orders INCLUDING DEFAULTS)`;
    for (const competitor of ['cancelled', 'delivered', 'deleted'] as const) {
      await connection`DELETE FROM orders`;
      await connection`INSERT INTO orders(id,order_number,shop_id) VALUES (${ORDER_ID},1,${SHOP_ID})`;
      const selected = deferred();
      const resume = deferred();
      app.use({ db: {
          select: (...args: Parameters<typeof database.select>) => pauseAfterSelect(database.select(...args), selected, resume),
          update: database.update.bind(database),
        } as unknown as Database });
      const verifying = request(app.app.getHttpServer()).post(`/api/v1/orders/${ORDER_ID}/verify`).set({ cookie: '__Host-neuton-session=test', 'x-shop-id': SHOP_ID });
      // Supertest starts the request when its promise is consumed.
      const result = Promise.resolve(verifying);
      await selected.promise;
      if (competitor === 'cancelled') {
        // Exercise the real cancellation transaction, including its row lock.
        app.use({ db: database });
        const cancelled = await request(app.app.getHttpServer()).delete(`/api/v1/orders/${ORDER_ID}`).set({ cookie: '__Host-neuton-session=test', 'x-shop-id': SHOP_ID });
        assert.equal(cancelled.status, 200);
      } else if (competitor === 'delivered') {
        await connection`UPDATE orders SET status = 'delivered' WHERE id = ${ORDER_ID}`;
      } else {
        await connection`UPDATE orders SET deleted_at = now() WHERE id = ${ORDER_ID}`;
      }
      resume.resolve();
      const response = await result;
      assert.equal(response.status, 409, `${competitor} must win over the stale verification`);
      assert.equal(response.body.error.code, 'CONFLICT');
      const [stored] = await database.select().from(orders);
      assert.equal(stored?.status, competitor === 'deleted' ? 'processing' : competitor);
      assert.equal(stored?.deletedAt !== null, competitor === 'deleted');
    }

    // Transaction-bound services queue audit/log effects for the owner of the outer commit.
    await connection`DELETE FROM orders`;
    await connection`INSERT INTO orders(id,order_number,shop_id) VALUES (${ORDER_ID},1,${SHOP_ID})`;
    const service = app.app.get(OrdersService);
    const effects: (() => Promise<void>)[] = [];
    const auditCount = app.audits.length;
    const actor = actorFor();
    const successLogs: unknown[] = [];
    actor.log = { ...actor.log, info: (...args: unknown[]) => { successLogs.push(args); } };
    await assert.rejects(database.transaction(async (tx) => {
      await service.inTransaction(tx, effect => effects.push(effect)).verify(actor, ORDER_ID);
      assert.equal(app.audits.length, auditCount);
      assert.equal(successLogs.length, 0);
      throw new Error('rollback outer sync');
    }), /rollback outer sync/);
    const [rolledBack] = await database.select().from(orders);
    assert.equal(rolledBack?.status, 'processing');
    assert.equal(app.audits.length, auditCount);
    assert.equal(successLogs.length, 0);
    assert.equal(effects.length, 1);
    effects.length = 0; // Outer rollback discards deferred effects.
    await database.transaction(async (tx) => {
      await service.inTransaction(tx, effect => effects.push(effect)).verify(actor, ORDER_ID);
      assert.equal(app.audits.length, auditCount);
      assert.equal(successLogs.length, 0);
    });
    for (const effect of effects) await effect();
    assert.equal(app.audits.length, auditCount + 1);
    assert.equal(successLogs.length, 1);
  } finally {
    await app.close();
    await connection.end();
  }
});

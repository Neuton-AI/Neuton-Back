import { skipWithoutDisposableDatabase } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('order snapshot migration preserves legacy financial rows and calendar dates across timezones', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const { db, sql: connection } = await import('../src/db/client.js');
  const { sql } = await import('drizzle-orm');
  const { orders, orderItems } = await import('../src/db/schema/orders.js');
  const orderId = randomUUID();
  const shopId = randomUUID();
  const recipeId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      // LIKE copies the full current row shape but not foreign keys. Removing
      // only the new columns reconstructs legacy rows before applying the DDL.
      await tx.execute(sql.raw(`CREATE TEMP TABLE orders (LIKE public.orders INCLUDING ALL) ON COMMIT DROP;
        ALTER TABLE orders DROP COLUMN delivery_date;
        CREATE TEMP TABLE order_items (LIKE public.order_items INCLUDING ALL) ON COMMIT DROP;
        ALTER TABLE order_items DROP COLUMN cost_complete;`));
      await tx.execute(sql`INSERT INTO orders (id,shop_id,order_number,customer_name,order_date,
        delivery_fee,total_amount,total_cost,delivery_distance_km,applied_profit_margin,status)
        VALUES (${orderId}::uuid,${shopId}::uuid,17,'Historical customer','2020-01-01T23:30:00-08:00',
          0,19.37,12.34,42,30,'delivered')`);
      await tx.execute(sql`INSERT INTO order_items (shop_id,order_id,recipe_id,recipe_name,quantity,unit_cost,unit_price)
        VALUES (${shopId}::uuid,${orderId}::uuid,${recipeId}::uuid,'Historical recipe',2,6.17,9.685)`);
      const beforeOrders = await tx.execute(sql`SELECT to_jsonb(orders) AS row FROM orders`);
      const beforeItems = await tx.execute(sql`SELECT to_jsonb(order_items) AS row FROM order_items`);
      const migration = readFileSync(new URL('../drizzle/0040_order_snapshots.sql', import.meta.url), 'utf8');
      await tx.execute(sql.raw(migration));
      const afterOrders = await tx.execute(sql`SELECT to_jsonb(orders)-'delivery_date' AS row FROM orders`);
      const afterItems = await tx.execute(sql`SELECT to_jsonb(order_items)-'cost_complete' AS row FROM order_items`);
      assert.deepEqual([...afterOrders], [...beforeOrders], 'all existing order values remain unchanged');
      assert.deepEqual([...afterItems], [...beforeItems], 'all existing line snapshots remain unchanged');
      const [legacyOrder] = await tx.select().from(orders);
      const [legacyLine] = await tx.select().from(orderItems);
      assert.equal(legacyOrder?.deliveryDate, null);
      assert.equal(legacyLine?.costComplete, null);
      const columns = await tx.execute(sql`SELECT attname,atthasdef,attnotnull FROM pg_attribute
        WHERE (attrelid='pg_temp.orders'::regclass AND attname='delivery_date')
        OR (attrelid='pg_temp.order_items'::regclass AND attname='cost_complete')`);
      assert.equal(columns.length, 2);
      for (const column of columns) {
        assert.equal(column.atthasdef, false);
        assert.equal(column.attnotnull, false);
      }
      await tx.insert(orders).values({ shopId, orderNumber: 18, deliveryDate: '2024-02-29' });
      await tx.insert(orderItems).values([true, false].map((costComplete) => ({
        shopId, orderId, recipeId, costComplete, recipeName: 'New snapshot',
      })));
      for (const timezone of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
        await tx.execute(sql`SELECT set_config('TimeZone',${timezone},true)`);
        const rows = await tx.select().from(orders).orderBy(orders.orderNumber);
        assert.deepEqual(rows.map((row) => row.deliveryDate), [null, '2024-02-29']);
      }
      const lines = await tx.select().from(orderItems);
      assert.deepEqual(lines.map((line) => line.costComplete).sort(), [false, null, true].sort());
    });
  } finally {
    await connection.end({ timeout: 5 });
  }
});

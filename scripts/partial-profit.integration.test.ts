import { skipWithoutDisposableDatabase } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';

after(async () => {
  if (!skipWithoutDisposableDatabase) {
    const { sql } = await import('../src/db/client.js');
    await sql.end({ timeout: 5 });
  }
});

test('mixed profit is frozen across create, reads, sync, analytics and later recipe changes', {
  skip: skipWithoutDisposableDatabase, timeout: 60_000,
}, async () => {
  const [{ db }, { sql }, { buildSyncApplication }, { AnalyticsPersistence, trendPercent }] = await Promise.all([
    import('../src/db/client.js'), import('drizzle-orm'), import('./support/syncApp.js'),
    import('../src/modules/analytics/analytics.persistence.js'),
  ]);
  const shopId = randomUUID(), userId = randomUUID(), completeId = randomUUID();
  const partialId = randomUUID(), zeroId = randomUUID(), inventoryId = randomUUID();
  await db.execute(sql`INSERT INTO users(id,email) VALUES (${userId}::uuid,${`${userId}@example.test`})`);
  await db.execute(sql`INSERT INTO shops(id,name,slug,target_profit_margin,hourly_labor_cost)
    VALUES (${shopId}::uuid,'Profit fixture',${shopId},30,1)`);
  const app = await buildSyncApplication(db, {
    id: shopId, name: 'Profit fixture', slug: shopId, currency: 'USD', timezone: 'UTC', storeAddress: null,
    targetProfitMargin: '30', hourlyLaborCost: '1', deliveryBaseFee: '0', deliveryRatePerKm: '0',
  }, userId);
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  try {
    await db.execute(sql`INSERT INTO inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,base_unit_average_cost)
      VALUES (${inventoryId}::uuid,${shopId}::uuid,'Flour','Flour','each','each',1,1.2345,1.2345)`);
    await db.execute(sql`INSERT INTO recipes(id,shop_id,name,status,yield_quantity,prep_time_minutes) VALUES
      (${completeId}::uuid,${shopId}::uuid,'Complete','verified',1,0),
      (${partialId}::uuid,${shopId}::uuid,'Partial','verified',3,60),
      (${zeroId}::uuid,${shopId}::uuid,'Zero','verified',1,0)`);
    await db.execute(sql`INSERT INTO recipe_ingredients(shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount) VALUES
      (${shopId}::uuid,${completeId}::uuid,${inventoryId}::uuid,'Flour','Flour',1,'each','each',1),
      (${shopId}::uuid,${partialId}::uuid,null,'Unknown','Unknown',1,'each','each',1),
      (${shopId}::uuid,${zeroId}::uuid,null,'Unknown','Unknown',1,'each','each',1)`);
    const ids: string[] = [];
    for (const sync of [false, true]) {
      const created = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: {
        ...headers, ...(sync ? { 'x-sync-id': randomUUID(), 'x-sync-version': String(Date.now()) } : {}),
      }, payload: { customerName: 'Ada', destinationAddress: 'Main St', orderDate: '2026-11-19T12:00:00Z',
        deliveryDate: '2026-11-20', deliveryFee: '1.00', items: [
          { recipeId: completeId, quantity: 3, expectedUnitPrice: '1.60' },
          { recipeId: partialId, quantity: 4, expectedUnitPrice: '0.33' },
          { recipeId: zeroId, quantity: 1, expectedUnitPrice: '0.00' },
        ] } });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().totals.netProfit, 1.1);
      const id: string = created.json().order.id;
      ids.push(id);
      const [stored] = await db.execute(sql`SELECT profit_snapshot,total_amount,total_cost FROM orders WHERE id=${id}::uuid`);
      assert.deepEqual(stored, { profit_snapshot: '1.10', total_amount: '7.12', total_cost: '5.04' });
      for (const snapshot of [false, true]) {
        const detail = await app.inject({ method: 'GET', url: `/api/v1/orders/${id}`, headers: {
          ...headers, ...(snapshot ? { 'x-sync-snapshot': 'true' } : {}),
        } });
        assert.equal(detail.statusCode, 200, detail.body);
        assert.equal(detail.json().order.netProfit, 1.1);
        assert.equal(detail.json().order.items.find((item: { recipeId: string }) => item.recipeId === partialId).costComplete, false);
        assert.equal('profitSnapshot' in detail.json().order, false, 'internal precision snapshot is not an API field');
      }
    }
    const legacyId = randomUUID(), oldPartialId = randomUUID(), priorId = randomUUID();
    await db.execute(sql`INSERT INTO orders(id,shop_id,order_number,order_date,total_amount,total_cost,delivery_fee,profit_snapshot) VALUES
      (${legacyId}::uuid,${shopId}::uuid,3,'2026-11-19T12:00:00Z',20,8,2,null),
      (${oldPartialId}::uuid,${shopId}::uuid,4,'2026-11-19T12:00:00Z',1,0.25,0,null),
      (${priorId}::uuid,${shopId}::uuid,5,'2026-10-10T12:00:00Z',6.99,4.70,0,2.30)`);
    await db.execute(sql`INSERT INTO order_items(shop_id,order_id,recipe_id,recipe_name,quantity,unit_price,unit_cost,cost_complete) VALUES
      (${shopId}::uuid,${legacyId}::uuid,${completeId}::uuid,'Complete',1,1,1,null),
      (${shopId}::uuid,${oldPartialId}::uuid,${partialId}::uuid,'Partial',1,1,0.25,false),
      (${shopId}::uuid,${priorId}::uuid,${completeId}::uuid,'Complete',3,2,1.23,true)`);
    const before = await db.execute(sql`SELECT to_jsonb(orders) AS row FROM orders WHERE shop_id=${shopId}::uuid ORDER BY order_number`);
    const analytics = new AnalyticsPersistence({ db, now: () => new Date('2026-11-19T15:00:00Z') });
    const summary = await analytics.dashboard(shopId, '30d');
    assert.equal(summary.summary.revenue, 35.24);
    assert.equal(summary.summary.productionCost, 18.33);
    assert.equal(summary.summary.deliveryFees, 4);
    assert.equal(summary.summary.netProfit, 12.2);
    assert.equal(summary.trend.profitPercent, trendPercent(12.2, 2.3));
    assert.deepEqual(summary.orderProfitability, { average: 3.05, median: 1.1, sampleSize: 4 });
    assert.equal(summary.graph.find(day => day.date === '2026-11-19')?.netProfit, 12.2);
    assert.equal(summary.topItem?.recipeId, partialId);
    assert.equal(summary.topItem?.netProfit, 0);
    const recent = await analytics.recent(shopId, 10);
    for (const order of recent.orders.filter(order => ids.includes(order.id))) assert.equal(order.netProfit, 1.1);
    assert.equal(recent.orders.find(order => order.id === legacyId)?.netProfit, 10);
    assert.equal(recent.orders.find(order => order.id === oldPartialId)?.netProfit, 0);
    await db.execute(sql`UPDATE recipes SET name=name||' changed',is_active=false,status='unverified' WHERE shop_id=${shopId}::uuid`);
    await db.execute(sql`UPDATE inventory_items SET base_unit_average_cost=99 WHERE id=${inventoryId}::uuid`);
    assert.deepEqual(await analytics.dashboard(shopId, '30d'), summary, 'current recipe prices/status cannot rewrite saved accounting');
    const list = await app.inject({ method: 'GET', url: '/api/v1/orders?limit=100', headers });
    assert.equal(list.statusCode, 200, list.body);
    for (const order of list.json().orders.filter((order: { id: string }) => ids.includes(order.id))) assert.equal(order.netProfit, 1.1);
    assert.deepEqual(await db.execute(sql`SELECT to_jsonb(orders) AS row FROM orders WHERE shop_id=${shopId}::uuid ORDER BY order_number`), before);
  } finally {
    await app.close();
    await db.execute(sql`DELETE FROM shops WHERE id=${shopId}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id=${userId}::uuid`);
  }
});

test('profit snapshot migration adds no defaults and preserves every historical financial field', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const [{ db }, { sql }] = await Promise.all([import('../src/db/client.js'), import('drizzle-orm')]);
  await db.transaction(async tx => {
    await tx.execute(sql.raw('CREATE TEMP TABLE orders (LIKE public.orders INCLUDING ALL) ON COMMIT DROP; ALTER TABLE orders DROP COLUMN IF EXISTS profit_snapshot'));
    await tx.execute(sql`INSERT INTO orders(shop_id,order_number,total_amount,total_cost,delivery_fee) VALUES (${randomUUID()}::uuid,17,19.37,12.34,0)`);
    const before = await tx.execute(sql`SELECT to_jsonb(orders) AS row FROM orders`);
    await tx.execute(sql.raw(readFileSync(new URL('../drizzle/0041_order_profit_snapshot.sql', import.meta.url), 'utf8')));
    assert.deepEqual(await tx.execute(sql`SELECT to_jsonb(orders)-'profit_snapshot' AS row FROM orders`), before);
    const [column] = await tx.execute(sql`SELECT atthasdef,attnotnull FROM pg_attribute WHERE attrelid='pg_temp.orders'::regclass AND attname='profit_snapshot'`);
    assert.deepEqual(column, { atthasdef: false, attnotnull: false });
  });
});

test('a decimal zero snapshot stays exactly zero in SQL aggregates and saved-order reads', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const [{ db }, { sql, getTableColumns }, { orders, orderItems }, { orderProfitCorrection, storedOrderProfit, readOrderProfit }] = await Promise.all([
    import('../src/db/client.js'), import('drizzle-orm'), import('../src/db/schema/orders.js'), import('../src/lib/orderProfit.js'),
  ]);
  await db.transaction(async tx => {
    await tx.execute(sql.raw(`CREATE TEMP TABLE orders (LIKE public.orders INCLUDING ALL) ON COMMIT DROP;
      CREATE TEMP TABLE order_items (LIKE public.order_items INCLUDING ALL) ON COMMIT DROP;`));
    const id = randomUUID(), shopId = randomUUID();
    await tx.insert(orders).values({ id, shopId, orderNumber: 1, totalAmount: '0.30', deliveryFee: '0.10', totalCost: '0.20', profitSnapshot: '0.00' });
    await tx.insert(orderItems).values({ shopId, orderId: id, recipeId: randomUUID(), unitPrice: '0.20', unitCost: '0.20', costComplete: false });
    const [order] = await tx.select({ ...getTableColumns(orders), profitCorrection: orderProfitCorrection }).from(orders);
    assert.ok(order);
    assert.equal(readOrderProfit(order), 0);
    const [aggregate] = await tx.select({ profit: sql<string>`coalesce(sum(${storedOrderProfit}),0)` }).from(orders);
    assert.equal(Number(aggregate?.profit), 0);
  });
});

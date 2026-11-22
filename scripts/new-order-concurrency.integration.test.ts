import { skipWithoutDisposableDatabase } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { pauseBeforeOrderWrite } from './support/pausedOrdersDatabase.js';

after(async () => {
  if (!skipWithoutDisposableDatabase) {
    const { sql: connection } = await import('../src/db/client.js');
    await connection.end({ timeout: 5 });
  }
});
async function fixture() {
  const [{ db }, { sql }, { buildSyncApplication }] = await Promise.all([
    import('../src/db/client.js'), import('drizzle-orm'), import('./support/syncApp.js'),
  ]);
  const shopId = randomUUID(), userId = randomUUID(), recipeId = randomUUID(), inventoryId = randomUUID(), ingredientId = randomUUID();
  await db.execute(sql`INSERT INTO users(id,email) VALUES (${userId}::uuid,${`${userId}@example.test`})`);
  await db.execute(sql`INSERT INTO shops(id,name,slug,target_profit_margin,hourly_labor_cost,delivery_base_fee,delivery_rate_per_km)
    VALUES (${shopId}::uuid,'Race fixture',${shopId},30,0,5,999)`);
  await db.execute(sql`INSERT INTO inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,base_unit_average_cost)
    VALUES (${inventoryId}::uuid,${shopId}::uuid,'Flour','Flour','each','each',1,2,2)`);
  await db.execute(sql`INSERT INTO recipes(id,shop_id,name,status) VALUES (${recipeId}::uuid,${shopId}::uuid,'Focaccia','verified')`);
  await db.execute(sql`INSERT INTO recipe_ingredients(id,shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount)
    VALUES (${ingredientId}::uuid,${shopId}::uuid,${recipeId}::uuid,${inventoryId}::uuid,'Flour','Flour',1,'each','each',1)`);
  const gate = pauseBeforeOrderWrite(db);
  const app = await buildSyncApplication(gate.database, {
    id: shopId, name: 'Race fixture', slug: shopId, currency: 'USD', timezone: 'UTC', storeAddress: null,
    targetProfitMargin: '30', hourlyLaborCost: '0', deliveryBaseFee: '5', deliveryRatePerKm: '999',
  }, userId);
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  const payload = { customerName: 'Dana', destinationAddress: 'Market Street', orderDate: '2026-11-20T12:00:00Z', deliveryDate: '2026-11-20', deliveryFee: '0.00',
    items: [{ recipeId, quantity: 1, expectedUnitPrice: '2.60' }] };
  const save = (sync = false) => app.inject({ method: 'POST', url: '/api/v1/orders', payload,
    headers: { ...headers, ...(sync ? { 'x-sync-id': randomUUID(), 'x-sync-version': String(Date.now()) } : {}) } });
  const counts = async () => (await db.execute(sql`SELECT
    (SELECT count(*)::int FROM orders WHERE shop_id=${shopId}::uuid) AS orders,
    (SELECT count(*)::int FROM order_items WHERE shop_id=${shopId}::uuid) AS lines,
    (SELECT count(*)::int FROM audit_logs WHERE shop_id=${shopId}::uuid AND event_type='ORDER_CREATED') AS audits,
    (SELECT last_order_number FROM shops WHERE id=${shopId}::uuid) AS number,
    (SELECT count(*)::int FROM document_mutations WHERE shop_id=${shopId}::uuid) AS receipts`))[0];
  return { db, sql, app, gate, shopId, recipeId, inventoryId, ingredientId, headers, payload, save, counts,
    async close() {
      gate.release();
      await app.close();
      await db.execute(sql`DELETE FROM shops WHERE id=${shopId}::uuid`);
      await db.execute(sql`DELETE FROM users WHERE id=${userId}::uuid`);
    },
  };
}
async function waitForRead(gate: ReturnType<typeof pauseBeforeOrderWrite>) {
  await Promise.race([gate.reached, new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('Creation did not reach the source-read barrier')), 10_000).unref();
  })]);
}

test('editing retains saved prices and invoice number, reviews new prices and rejects stale saves', {
  skip: skipWithoutDisposableDatabase, timeout: 30_000,
}, async () => {
  const f = await fixture();
  f.gate.release();
  try {
    const created = await f.save();
    assert.equal(created.statusCode, 201, created.body);
    const order = created.json().order;
    const url = `/api/v1/orders/${order.id}`;
    const read = () => f.app.inject({ method: 'GET', url, headers: { ...f.headers, 'x-sync-snapshot': 'true' } });
    const before = await read();
    assert.equal(before.statusCode, 200, before.body);
    const { syncVersion, order: { items: [saved] } } = before.json();
    const addedId = randomUUID();
    await f.db.execute(f.sql`UPDATE recipes SET is_active=false, name='Renamed' WHERE id=${f.recipeId}::uuid`);
    await f.db.execute(f.sql`INSERT INTO recipes(id,shop_id,name,status) VALUES (${addedId}::uuid,${f.shopId}::uuid,'Cake','verified')`);
    await f.db.execute(f.sql`INSERT INTO recipe_ingredients(shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount)
      VALUES (${f.shopId}::uuid,${addedId}::uuid,${f.inventoryId}::uuid,'Flour','Flour',1,'each','each',1)`);

    const edit = (price: string, base: number, mutationId = randomUUID(), version = Math.max(Date.now(), base + 1)) =>
      f.app.inject({
        method: 'PATCH', url,
        headers: { ...f.headers, 'x-sync-id': mutationId, 'x-sync-version': String(version), 'x-sync-base-version': String(base) },
        payload: {
          customerName: 'Maya', deliveryFee: '0.00',
          items: [{ lineId: saved.id, quantity: 2 }, { recipeId: addedId, quantity: 1, expectedUnitPrice: price }],
        },
      });

    const priceConflict = await edit('1.00', syncVersion);
    assert.equal(priceConflict.statusCode, 409, priceConflict.body);
    assert.equal(priceConflict.json().error.code, 'ORDER_REVIEW_REQUIRED');
    const mutationId = randomUUID();
    const version = Math.max(Date.now(), syncVersion + 1);
    const updated = await edit('2.60', syncVersion, mutationId, version);
    assert.equal(updated.statusCode, 200, updated.body);
    const next = updated.json();
    assert.equal(next.syncVersion, version);
    assert.equal(next.order.id, order.id);
    assert.equal(next.order.orderNumber, order.orderNumber);
    assert.equal(next.order.customerName, 'Maya');
    assert.equal(next.order.totalAmount, '7.80');
    const retained = next.order.items.find((line: { id: string }) => line.id === saved.id);
    assert.equal(retained.quantity, '2.000');
    assert.equal(retained.name, saved.name);
    assert.equal(retained.unitPrice, saved.unitPrice);
    assert.deepEqual((await edit('2.60', syncVersion, mutationId, version)).json(), next);
    assert.equal((await edit('2.60', syncVersion)).statusCode, 409);
    assert.equal((await f.counts())?.number, 1);

    const delivered = await f.app.inject({ method: 'POST', url: `${url}/verify`, headers: f.headers });
    assert.equal(delivered.statusCode, 200, delivered.body);
    const deliveredVersion = (await read()).json().syncVersion;
    const locked = await edit('2.60', deliveredVersion);
    assert.equal(locked.statusCode, 409, locked.body);
    assert.match(locked.body, /Only processing orders can be edited/);
  } finally {
    await f.close();
  }
});
for (const sync of [false, true]) {
  test(`shop price race reruns review without invoice, audit or receipt effects (sync=${sync})`, { skip: skipWithoutDisposableDatabase, timeout: 30_000 }, async () => {
    const f = await fixture();
    const pending = f.save(sync);
    try {
      await waitForRead(f.gate);
      await f.db.execute(f.sql`UPDATE shops SET target_profit_margin=50 WHERE id=${f.shopId}::uuid`);
      f.gate.release();
      const result = await pending;
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().error.code, 'ORDER_REVIEW_REQUIRED');
      assert.equal(result.json().error.details.priceChanges[0].currentUnitPrice, '3.00');
      assert.ok(f.gate.attempts() >= 2);
      assert.deepEqual(await f.counts(), { orders: 0, lines: 0, audits: 0, number: 0, receipts: 0 });
    } finally {
      f.gate.release();
      await pending.catch(() => undefined);
      await f.close();
    }
  });
}

for (const change of ['inventory-price', 'ingredient-link', 'ingredient-insert', 'recipe-inactive', 'recipe-unverified']) {
  test(`a concurrent ${change} cannot mix snapshots or bypass the next review`, { skip: skipWithoutDisposableDatabase, timeout: 30_000 }, async () => {
    const f = await fixture();
    const pending = f.save();
    try {
      await waitForRead(f.gate);
      if (change === 'inventory-price') {
        await f.db.execute(f.sql`UPDATE inventory_items SET base_unit_average_cost=4 WHERE id=${f.inventoryId}::uuid`);
      } else if (change === 'ingredient-link') {
        const nextInventory = randomUUID();
        await f.db.execute(f.sql`INSERT INTO inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,base_unit_average_cost)
          VALUES (${nextInventory}::uuid,${f.shopId}::uuid,'New flour','New flour','each','each',1,4,4)`);
        await f.db.execute(f.sql`UPDATE recipe_ingredients SET inventory_item_id=${nextInventory}::uuid WHERE id=${f.ingredientId}::uuid`);
      } else if (change === 'ingredient-insert') {
        await f.db.execute(f.sql`INSERT INTO recipe_ingredients(shop_id,recipe_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount)
          VALUES (${f.shopId}::uuid,${f.recipeId}::uuid,'Unresolved','Unresolved',1,'each','each',1)`);
      } else if (change === 'recipe-inactive') {
        await f.db.execute(f.sql`UPDATE recipes SET is_active=false WHERE id=${f.recipeId}::uuid`);
      } else {
        await f.db.execute(f.sql`UPDATE recipes SET status='unverified' WHERE id=${f.recipeId}::uuid`);
      }
      f.gate.release();
      const created = await pending;
      assert.ok([201, 409].includes(created.statusCode), created.body);
      if (created.statusCode === 201) {
        assert.equal(created.json().totals.totalAmount, 2.6, 'accepted state is the consistent pre-change snapshot');
        const lines = await f.db.execute(f.sql`SELECT unit_cost,unit_price,cost_complete FROM order_items WHERE shop_id=${f.shopId}::uuid`);
        assert.deepEqual(lines[0], { unit_cost: '2.00', unit_price: '2.60', cost_complete: true });
      }
      const beforeRetry = await f.counts();
      const retry = await f.save();
      assert.equal(retry.statusCode, 409, retry.body);
      if (change.startsWith('recipe-')) {
        assert.equal(retry.json().error.code, 'NO_AVAILABLE_ITEMS');
      } else {
        assert.equal(retry.json().error.code, 'ORDER_REVIEW_REQUIRED');
        const price = change === 'ingredient-insert' ? '2.00' : '5.20';
        assert.equal(retry.json().error.details.priceChanges[0].currentUnitPrice, price);
      }
      assert.deepEqual(await f.counts(), beforeRetry, 'a fresh stale-price save has no new effects');
    } finally {
      f.gate.release();
      await pending.catch(() => undefined);
      await f.close();
    }
  });
}

for (const sync of [false, true]) {
  test(`a successful rollback retry emits one audit and preserves explicit zero (sync=${sync})`, { skip: skipWithoutDisposableDatabase, timeout: 30_000 }, async () => {
    const f = await fixture();
    const pending = f.save(sync);
    try {
      await waitForRead(f.gate);
      await f.db.execute(f.sql`UPDATE shops SET delivery_base_fee=7 WHERE id=${f.shopId}::uuid`);
      f.gate.release();
      const result = await pending;
      assert.equal(result.statusCode, 201, result.body);
      assert.equal(result.json().order.deliveryFee, '0.00');
      assert.ok(f.gate.attempts() >= 2);
      assert.deepEqual(await f.counts(), { orders: 1, lines: 1, audits: 1, number: 1, receipts: sync ? 1 : 0 });
    } finally {
      f.gate.release();
      await pending.catch(() => undefined);
      await f.close();
    }
  });
}
test('concurrent replays of one sync mutation create one invoice and one success audit', { skip: skipWithoutDisposableDatabase }, async () => {
  const f = await fixture();
  f.gate.release();
  try {
    const headers = { ...f.headers, 'x-sync-id': randomUUID(), 'x-sync-version': String(Date.now()) };
    const save = () => f.app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: f.payload });
    const [first, second] = await Promise.all([save(), save()]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(second.statusCode, 201, second.body);
    assert.deepEqual(first.json(), second.json());
    assert.deepEqual(await f.counts(), { orders: 1, lines: 1, audits: 1, number: 1, receipts: 1 });
  } finally { await f.close(); }
});
test('a concurrent physical deletion cannot invalidate a recipe between review and line insertion', { skip: skipWithoutDisposableDatabase }, async () => {
  const f = await fixture();
  const pending = f.save();
  try {
    await waitForRead(f.gate);
    const { getDatabaseErrorCode } = await import('../src/lib/dbErrors.js');
    await assert.rejects(f.db.transaction(async tx => {
      await tx.execute(f.sql`SET LOCAL lock_timeout='100ms'`);
      await tx.execute(f.sql`DELETE FROM recipes WHERE id=${f.recipeId}::uuid`);
    }), error => getDatabaseErrorCode(error) === '55P03');
    f.gate.release();
    const result = await pending;
    assert.equal(result.statusCode, 201, result.body);
    assert.deepEqual(await f.counts(), { orders: 1, lines: 1, audits: 1, number: 1, receipts: 0 });
  } finally {
    f.gate.release();
    await pending.catch(() => undefined);
    await f.close();
  }
});
for (const state of ['deleted', 'inactive', 'unverified', 'malformed-yield', 'restored-exclusion']) {
  test(`current ${state} rejects creation without financial side effects`, { skip: skipWithoutDisposableDatabase }, async () => {
    const f = await fixture();
    f.gate.release();
    try {
      if (state === 'deleted') {
        await f.db.execute(f.sql`DELETE FROM recipes WHERE id=${f.recipeId}::uuid`);
      }
      if (state === 'inactive') {
        await f.db.execute(f.sql`UPDATE recipes SET is_active=false WHERE id=${f.recipeId}::uuid`);
      }
      if (state === 'unverified') {
        await f.db.execute(f.sql`UPDATE recipes SET status='unverified' WHERE id=${f.recipeId}::uuid`);
      }
      if (state === 'malformed-yield') {
        await f.db.execute(f.sql`UPDATE recipes SET yield_quantity=0 WHERE id=${f.recipeId}::uuid`);
      }
      const payload = { ...f.payload, deliveryFee: '7.00', ...(state === 'restored-exclusion' ? { confirmedUnavailableRecipeIds: [f.recipeId] } : {}) };
      const result = await f.app.inject({ method: 'POST', url: '/api/v1/orders', headers: f.headers, payload });
      assert.equal(result.statusCode, state === 'malformed-yield' ? 400 : 409, result.body);
      let code = 'NO_AVAILABLE_ITEMS';
      if (state === 'malformed-yield') {
        code = 'INVALID_RECIPE_YIELD';
      }
      if (state === 'restored-exclusion') {
        code = 'ORDER_REVIEW_REQUIRED';
      }
      assert.equal(result.json().error.code, code);
      assert.deepEqual(await f.counts(), { orders: 0, lines: 0, audits: 0, number: 0, receipts: 0 });
    } finally { await f.close(); }
  });
}

test('a shared general-price race preserves the source snapshot and updates the next review', { skip: skipWithoutDisposableDatabase }, async () => {
  const f = await fixture();
  const generalId = randomUUID();
  await f.db.execute(f.sql`INSERT INTO general_prices(id,raw_name,raw_material_name,base_unit,base_unit_amount,base_unit_cost)
    VALUES (${generalId}::uuid,'Shared flour',${generalId},'each',1,2)`);
  await f.db.execute(f.sql`UPDATE recipe_ingredients SET inventory_item_id=null,general_price_id=${generalId}::uuid WHERE id=${f.ingredientId}::uuid`);
  const pending = f.save();
  try {
    await waitForRead(f.gate);
    await f.db.execute(f.sql`UPDATE general_prices SET base_unit_cost=4 WHERE id=${generalId}::uuid`);
    f.gate.release();
    const first = await pending;
    assert.ok([201, 409].includes(first.statusCode), first.body);
    if (first.statusCode === 201) {
      assert.equal(first.json().totals.totalAmount, 2.6);
    }
    const before = await f.counts();
    const next = await f.save();
    assert.equal(next.statusCode, 409, next.body);
    assert.equal(next.json().error.details.priceChanges[0].currentUnitPrice, '5.20');
    assert.deepEqual(await f.counts(), before);
  } finally {
    f.gate.release();
    await pending.catch(() => undefined);
    await f.close();
    await f.db.execute(f.sql`DELETE FROM general_prices WHERE id=${generalId}::uuid`);
  }
});
test('foreign recipe IDs expose no foreign names, prices or financial effects', { skip: skipWithoutDisposableDatabase }, async () => {
  const f = await fixture();
  const foreignShop = randomUUID(), foreignRecipe = randomUUID();
  f.gate.release();
  try {
    await f.db.execute(f.sql`INSERT INTO shops(id,name,slug) VALUES (${foreignShop}::uuid,'Foreign shop',${foreignShop})`);
    await f.db.execute(f.sql`INSERT INTO recipes(id,shop_id,name,status) VALUES (${foreignRecipe}::uuid,${foreignShop}::uuid,'Private foreign recipe','verified')`);
    const result = await f.app.inject({ method: 'POST', url: '/api/v1/orders', headers: f.headers,
      payload: { ...f.payload, items: [...f.payload.items, { recipeId: foreignRecipe, quantity: 1, expectedUnitPrice: '0.00' }] } });
    assert.equal(result.statusCode, 409, result.body);
    assert.deepEqual(result.json().error.details.unavailable, [{ recipeId: foreignRecipe, reason: 'NOT_FOUND' }]);
    assert.equal(result.body.includes('Private foreign recipe'), false);
    assert.equal(result.json().error.details.currentItems.length, 1);
    assert.deepEqual(await f.counts(), { orders: 0, lines: 0, audits: 0, number: 0, receipts: 0 });
  } finally {
    await f.close();
    await f.db.execute(f.sql`DELETE FROM shops WHERE id=${foreignShop}::uuid`);
  }
});

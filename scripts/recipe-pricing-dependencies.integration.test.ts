import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { buildSyncApplication } from './support/syncApp.js';

test('ingredient, inventory, general-price and shop edits deliver fresh pricing snapshots through existing sync', {
  skip: skipWithoutDisposableDatabase, timeout: 30_000,
}, async () => {
  const connection = postgres(testDatabaseUrl!, { max: 2 });
  const db = drizzle(connection, { schema });
  const shopId = randomUUID(), userId = randomUUID(), recipeId = randomUUID();
  const ingredientId = randomUUID(), inventoryId = randomUUID(), priceId = randomUUID();
  const shop = {
    id: shopId, name: 'Pricing sync', slug: shopId, currency: 'USD', timezone: 'UTC',
    storeAddress: null, targetProfitMargin: '30', hourlyLaborCost: '0',
    deliveryBaseFee: '0', deliveryRatePerKm: '0',
  };
  const app = await buildSyncApplication(db, shop, userId);
  const headers = { cookie: '__Host-neuton-session=test-session', 'x-shop-id': shopId };
  let version = 0;
  const changed = async (mutation: SQL, expectedPrice: string, deleted = false) => {
    await db.execute(mutation);
    const comparison = await app.inject({ method: 'POST', url: '/api/v1/sync/check', headers,
      payload: { documents: [{ kind: 'recipe', id: recipeId, updatedAt: version }] } });
    assert.equal(comparison.statusCode, 200, comparison.body);
    const meta = comparison.json().toPull.find((row: { id: string }) => row.id === recipeId);
    assert.ok(meta, 'dependency edit invalidates the previously downloaded version');
    assert.ok(meta.updatedAt > version);
    version = meta.updatedAt;
    assert.equal(meta.deleted, deleted);
    if (deleted) return;
    const response = await app.inject({ method: 'GET', url: `/api/v1/recipes/${recipeId}`,
      headers: { ...headers, 'x-sync-snapshot': 'true' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().syncVersion, version);
    assert.equal(response.json().recipe.orderPricing.unitPrice, expectedPrice);
  };
  try {
    await db.execute(sql`INSERT INTO shops(id,name,slug,hourly_labor_cost,target_profit_margin)
      VALUES (${shopId}::uuid,'Pricing sync',${shopId},0,30)`);
    await db.execute(sql`INSERT INTO recipes(id,shop_id,name,status,prep_time_minutes,yield_quantity)
      VALUES (${recipeId}::uuid,${shopId}::uuid,'Bread','verified',60,2)`);
    await db.execute(sql`INSERT INTO inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,base_unit_average_cost)
      VALUES (${inventoryId}::uuid,${shopId}::uuid,'Flour','Flour','g','g',1,3,3)`);
    await db.execute(sql`INSERT INTO general_prices(id,raw_name,raw_material_name,base_unit,base_unit_amount,base_unit_cost)
      VALUES (${priceId}::uuid,'Flour',${priceId},'g',1,4)`);
    await changed(sql`INSERT INTO recipe_ingredients(id,shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount)
      VALUES (${ingredientId}::uuid,${shopId}::uuid,${recipeId}::uuid,${inventoryId}::uuid,'Flour','Flour',2,'g','g',2)`, '3.90');
    await changed(sql`UPDATE inventory_items SET base_unit_average_cost=4 WHERE id=${inventoryId}::uuid`, '5.20');
    await changed(sql`UPDATE recipe_ingredients SET inventory_item_id=null,general_price_id=${priceId}::uuid WHERE id=${ingredientId}::uuid`, '5.20');
    await changed(sql`UPDATE general_prices SET base_unit_cost=5 WHERE id=${priceId}::uuid`, '6.50');
    await changed(sql`UPDATE recipe_ingredients SET base_unit_amount=4 WHERE id=${ingredientId}::uuid`, '13.00');
    shop.hourlyLaborCost = '2'; // The auth fixture mirrors the newly saved shop context.
    await changed(sql`UPDATE shops SET hourly_labor_cost=2 WHERE id=${shopId}::uuid`, '14.30');
    shop.targetProfitMargin = '50';
    await changed(sql`UPDATE shops SET target_profit_margin=50 WHERE id=${shopId}::uuid`, '16.50');
    await changed(sql`UPDATE recipes SET is_active=false WHERE id=${recipeId}::uuid`, '', true);
    await db.execute(sql`UPDATE general_prices SET base_unit_cost=6 WHERE id=${priceId}::uuid`);
    await changed(sql`UPDATE recipes SET is_active=true WHERE id=${recipeId}::uuid`, '19.50');
    await changed(sql`DELETE FROM recipe_ingredients WHERE id=${ingredientId}::uuid`, '1.00');
  } finally {
    await app.close();
    await db.execute(sql`DELETE FROM shops WHERE id=${shopId}::uuid`);
    await db.execute(sql`DELETE FROM general_prices WHERE id=${priceId}::uuid`);
    await connection.end({ timeout: 5 });
  }
});

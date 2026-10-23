import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import request from 'supertest';
import * as schema from '../src/db/schema/index.js';
import { buildNestCatalogApp, SHOP_ID } from './support/nestCatalogApp.js';

const databaseUrl = process.env.API_ALIGNMENT_TEST_DATABASE_URL;

test('Nest catalog SQL isolates shops and applies search, active and low-stock filters', {
  skip: !databaseUrl && 'requires migrated disposable API_ALIGNMENT_TEST_DATABASE_URL',
  timeout: 30_000,
}, async () => {
  const namespace = `catalog_${randomUUID().replaceAll('-', '')}`;
  const connection = postgres(databaseUrl!, {
    max: 2, onnotice() {}, connection: { search_path: namespace },
  });
  let app: Awaited<ReturnType<typeof buildNestCatalogApp>> | undefined;
  try {
    await connection.unsafe(`CREATE SCHEMA ${namespace};
      CREATE TABLE ${namespace}.categories (LIKE public.categories INCLUDING ALL);
      CREATE TABLE ${namespace}.inventory_items (LIKE public.inventory_items INCLUDING ALL);`);
    const foreignShop = randomUUID();
    await connection`INSERT INTO categories(shop_id,name) VALUES
      (${SHOP_ID},'Zulu'),(${foreignShop},'Foreign'),(${SHOP_ID},'Alpha')`;
    await connection`INSERT INTO inventory_items
      (shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,current_quantity,reorder_level,is_active)
      VALUES
      (${SHOP_ID},'Threshold','flour','kg','g',1000,0.01,2,2,true),
      (${SHOP_ID},'No threshold','flour','kg','g',1000,0.01,0,null,true),
      (${SHOP_ID},'Inactive','flour','kg','g',1000,0.01,0,1,false),
      (${foreignShop},'Foreign','flour','kg','g',1000,0.01,0,1,true)`;
    app = await buildNestCatalogApp(drizzle(connection, { schema }), 'member');
    const get = (path: string) => request(app!.app.getHttpServer()).get(`/api/v1${path}`)
      .set({ authorization: 'Bearer test', 'x-shop-id': SHOP_ID });
    const categories = await get('/categories');
    assert.equal(categories.status, 200);
    assert.deepEqual(categories.body.categories.map((row: { name: string }) => row.name), ['Alpha', 'Zulu']);
    const names = (response: { body: { items: { name: string }[] } }) => response.body.items.map(row => row.name);
    const inventory = await get('/inventory');
    assert.equal(inventory.status, 200);
    assert.deepEqual(names(inventory), ['No threshold', 'Threshold']);
    assert.deepEqual(inventory.body.items.map((row: { isLowStock: boolean }) => row.isLowStock), [false, true]);
    assert.deepEqual(names(await get('/inventory?search=No%20ThResHold')), ['No threshold']);
    assert.deepEqual(names(await get('/inventory?lowStockOnly=true')), ['Threshold']);
    assert.deepEqual(names(await get('/inventory?includeInactive=true&lowStockOnly=true')), ['Inactive', 'Threshold']);
    // Query boolean policy is unchanged in this extraction; a later audit slice fixes coercion.
    assert.deepEqual(names(await get('/inventory?includeInactive=false')), ['Inactive', 'No threshold', 'Threshold']);
  } finally {
    await app?.close();
    await connection.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await connection.end({ timeout: 5 });
  }
});

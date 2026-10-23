import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { buildCatalogApp, SHOP_ID, USER_ID } from './support/catalogApp.js';
import { adjustInventory } from '../src/lib/inventoryAdjustments.js';
import * as tables from '../src/db/schema/index.js';

const databaseUrl = process.env.API_ALIGNMENT_TEST_DATABASE_URL;
test('stock batches rollback, serialize retries, reject payload reuse and foreign IDs', { skip: !databaseUrl && 'requires disposable API_ALIGNMENT_TEST_DATABASE_URL' }, async () => {
  const schema = `adjustments_${randomUUID().replaceAll('-', '')}`;
  const connection = postgres(databaseUrl!, { max: 4, onnotice() {}, connection: { search_path: schema } });
  const first = randomUUID();
  const second = randomUUID();
  const other = randomUUID();
  const otherShop = randomUUID();
  const h = await buildCatalogApp();
  try {
    await connection.unsafe(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.inventory_items(id uuid PRIMARY KEY, shop_id uuid NOT NULL, current_quantity numeric NOT NULL CHECK(current_quantity <> 13), updated_at timestamptz DEFAULT now());
      CREATE TABLE ${schema}.inventory_adjustment_batches(shop_id uuid NOT NULL, id uuid NOT NULL, user_id uuid NOT NULL, request_hash text NOT NULL, response jsonb, PRIMARY KEY(shop_id,id));`);
    await connection`INSERT INTO inventory_items(id,shop_id,current_quantity) VALUES (${first},${SHOP_ID},10),(${second},${SHOP_ID},10),(${other},${otherShop},10)`;
    const database = drizzle(connection, { schema: tables });
    h.use({ db: database as never, deleteObject: async () => {} });
    const send = (adjustments: { inventoryItemId: string; deltaQuantity: number }[], key: string = randomUUID()) => h.app.inject({
      method: 'POST', url: '/api/v1/inventory/adjust', payload: { adjustments }, headers: key ? { 'idempotency-key': key } : {},
    });
    const amounts = async () => Object.fromEntries((await connection`SELECT id,current_quantity FROM inventory_items`).map(row => [row.id, Number(row.current_quantity)]));
    const failed = await send([{ inventoryItemId: first, deltaQuantity: 2 }, { inventoryItemId: second, deltaQuantity: 3 }], randomUUID());
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal((await amounts())[first], 10, 'a later failure must rollback the first delta');
    assert.equal((await connection`SELECT * FROM inventory_adjustment_batches`).length, 0, 'failed transaction cannot retain a retry receipt');

    const key = randomUUID();
    const batch = [{ inventoryItemId: first, deltaQuantity: 2 }];
    const [a, b] = await Promise.all([send(batch, key), send(batch, key)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json());
    assert.deepEqual(a.json(), { adjusted: 1, ids: [first] });
    assert.equal((await amounts())[first], 12, 'concurrent retry must apply once');
    assert.equal((await connection`SELECT user_id FROM inventory_adjustment_batches`)[0]?.user_id, USER_ID);
    assert.equal((await send([{ inventoryItemId: first, deltaQuantity: 4 }], key)).statusCode, 409);
    assert.equal((await amounts())[first], 12);
    await assert.rejects(adjustInventory(database, { shopId: SHOP_ID, userId: randomUUID(), key, adjustments: batch }), { statusCode: 409 });
    assert.equal((await amounts())[first], 12, 'another user cannot replay a saved result');
    assert.deepEqual(await adjustInventory(database, { shopId: otherShop, userId: USER_ID, key, adjustments: [{ inventoryItemId: other, deltaQuantity: 2 }] }), { adjusted: 1, ids: [other] });
    assert.equal((await amounts())[other], 12, 'another shop has an independent retry namespace');
    assert.equal((await send([{ inventoryItemId: first, deltaQuantity: 1 }, { inventoryItemId: other, deltaQuantity: 1 }])).statusCode, 403);
    assert.equal((await amounts())[first], 12, 'foreign item rejects entire batch');
    assert.equal((await send([...batch, ...batch])).statusCode, 400, 'duplicate IDs are ambiguous');
  } finally {
    await h.close();
    await connection.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await connection.end();
  }
});

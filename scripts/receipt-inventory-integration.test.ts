import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { verifyReceipt } from '../src/lib/verifyReceipt.js';

// Opt in with a disposable database; never repoint the normal developer database.
const databaseUrl = process.env.RECEIPT_INVENTORY_TEST_DATABASE_URL;
const skip = !databaseUrl && 'requires RECEIPT_INVENTORY_TEST_DATABASE_URL';

test('migration converts package amounts and backfills the latest 20 verified costs', { skip }, async () => {
  const connection = postgres(databaseUrl!, { max: 1 });
  try {
    await connection.begin(async (tx) => {
      // Temporary tables shadow the application tables and disappear at commit.
      await tx.unsafe(`
        CREATE TEMP TABLE inventory_items (
          id integer, shop_id integer, base_unit text,
          base_unit_amount numeric(12,2), current_quantity numeric(12,3)
        ) ON COMMIT DROP;
        CREATE TEMP TABLE receipts (
          id integer, shop_id integer, status text, verified_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE receipt_items (
          id integer, shop_id integer, receipt_id integer, inventory_item_id integer,
          base_unit text, base_unit_amount numeric(12,3), quantity numeric(12,3), unit_price numeric(12,4)
        ) ON COMMIT DROP;
        INSERT INTO inventory_items VALUES (1, 1, 'g', 500, 42), (2, 1, 'g', 0, 0);
        INSERT INTO receipts
          SELECT n, 1, 'verified', '2026-01-01'::timestamptz + n * interval '1 minute'
          FROM generate_series(1, 21) n;
        INSERT INTO receipt_items
          SELECT n, 1, n, 1, 'g', 500, 2, n * 500 FROM generate_series(1, 21) n;
        INSERT INTO receipts VALUES (22, 1, 'unverified', now());
        INSERT INTO receipt_items VALUES
          (22, 1, 22, 1, 'g', 500, 2, 50000),
          (23, 1, 21, NULL, 'g', 500, 2, 50000),
          (24, 1, 21, 1, 'g', 500, 0, 50000);
      `);
      const migration = readFileSync(new URL('../drizzle/0024_receipt_inventory_totals_and_cost_sma.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        await tx.unsafe(statement);
      }
      const rows = await tx`SELECT base_unit_amount, base_unit_average_cost FROM inventory_items ORDER BY id`;
      assert.equal(rows[0]?.base_unit_amount, '21000.000');
      assert.equal(rows[0]?.base_unit_average_cost, '11.500000');
      assert.equal(rows[1]?.base_unit_average_cost, '0.000000');
    });
  } finally {
    await connection.end();
  }
});

test('verified purchases accumulate total base units and serialize concurrent SMA updates', { skip }, async () => {
  const connection = postgres(databaseUrl!, { max: 5 });
  const db = drizzle(connection, { schema });
  const shopId = randomUUID();
  const userId = randomUUID();
  try {
    await db.insert(schema.profiles).values({ id: userId });
    await db.insert(schema.shops).values({ id: shopId, name: 'Receipt inventory regression', slug: shopId });
    async function purchase(cost: number, quantity: number, accepted = true) {
      const [receipt] = await db.insert(schema.receipts).values({ shopId, status: 'unverified' }).returning();
      assert.ok(receipt);
      const [line] = await db.insert(schema.receiptItems).values({
        receiptId: receipt.id, shopId, rawName: 'Flour', rawMaterialName: 'Flour',
        srcUnit: 'unit', quantity: String(quantity), unitPrice: String(cost * 500),
        baseUnit: 'g', baseUnitAmount: '500',
      }).returning();
      assert.ok(line);
      return { db, shopId, userId, receiptId: receipt.id, items: [{ id: line.id, accepted }] };
    }

    let lastPurchase;
    for (let cost = 1; cost <= 21; cost++) {
      lastPurchase = await purchase(cost, cost);
      await verifyReceipt(lastPurchase);
    }
    const [before] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.shopId, shopId));
    assert.ok(before);
    assert.equal(before?.baseUnitAmount, '115500.000');
    assert.equal(before?.baseUnitAverageCost, '11.500000');
    await assert.rejects(verifyReceipt(lastPurchase!), /already verified/);

    const concurrent = await Promise.all([purchase(22, 2), purchase(23, 3)]);
    await Promise.all(concurrent.map(verifyReceipt));
    await verifyReceipt(await purchase(999, 100, false));
    const [after] = await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, before.id));
    assert.equal(after?.baseUnitAmount, '118000.000');
    assert.equal(after?.baseUnitAverageCost, '13.500000');
    assert.equal(after?.currentQuantity, '236.000');
  } finally {
    await db.delete(schema.shops).where(eq(schema.shops.id, shopId));
    await db.delete(schema.profiles).where(eq(schema.profiles.id, userId));
    await connection.end();
  }
});

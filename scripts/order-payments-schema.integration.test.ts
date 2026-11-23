import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';

test('payment migration leaves preexisting orders untouched with empty histories', {
  skip: skipWithoutDisposableDatabase,
  timeout: 10000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const schemaName = `payment_upgrade_${randomUUID().replaceAll('-', '')}`;
  const orderId = randomUUID();
  const rollback = new Error('Discard the isolated upgrade fixture');
  try {
    await assert.rejects(connection.begin(async tx => {
      await tx`CREATE SCHEMA ${tx(schemaName)}`;
      await tx`SET LOCAL search_path TO ${tx(schemaName)}, public`;
      await tx`CREATE TABLE orders (LIKE public.orders INCLUDING ALL)`;
      const [before] = await tx`INSERT INTO orders (id, shop_id, order_number, status, total_amount)
        VALUES (${orderId}, ${randomUUID()}, 1, 'delivered', 19.37) RETURNING *`;
      const migration = readFileSync(new URL('../drizzle/0042_order_payments.sql', import.meta.url), 'utf8');
      await tx.unsafe(migration);
      const [after] = await tx`SELECT * FROM orders WHERE id = ${orderId}`;
      assert.deepEqual(after, before);
      assert.equal((await tx`SELECT id FROM order_payments WHERE order_id = ${orderId}`).length, 0);
      throw rollback;
    }), error => error === rollback);
  } finally {
    await connection.end();
  }
});

test('order payment history enforces amount, kind, refund uniqueness, and ownership constraints', {
  skip: skipWithoutDisposableDatabase,
  timeout: 10000,
}, async () => {
  const connection = postgres(testDatabaseUrl!);
  const shopId = randomUUID();
  const orderId = randomUUID();
  const actorId = randomUUID();
  const occurredAt = '2026-11-20T08:00:00.000Z';
  let shopCreated = false;
  try {
    await connection`INSERT INTO shops (id, name, slug) VALUES (${shopId}, 'Payment schema', ${shopId})`;
    shopCreated = true;
    await connection`INSERT INTO users (id, email, password_hash) VALUES (${actorId}, ${`${actorId}@example.test`}, 'unused-fixture-hash')`;
    await connection`INSERT INTO orders (id, shop_id, order_number, status) VALUES (${orderId}, ${shopId}, 1, 'delivered')`;
    assert.equal((await connection`SELECT id FROM order_payments WHERE order_id = ${orderId}`).length, 0);

    const insert = async (kind: string, amount: string) => connection`
      INSERT INTO order_payments (order_id, kind, amount, occurred_at, recorded_by_user_id)
      VALUES (${orderId}, ${kind}, ${amount}, ${occurredAt}, ${actorId})
      RETURNING id, amount, occurred_at, recorded_at`;
    for (const amount of ['0', '-0.01', 'NaN']) {
      await assert.rejects(insert('deposit', amount), { code: '23514' });
    }
    await assert.rejects(insert('unknown', '1.00'), { code: '23514' });
    const [deposit] = await insert('deposit', '50.10');
    assert.ok(deposit?.id);
    assert.equal(deposit?.amount, '50.10');
    assert.equal(deposit?.occurred_at.toISOString(), occurredAt);
    assert.ok(deposit?.recorded_at instanceof Date);
    await insert('deposit', '5.00');
    await insert('payment', '10.00');
    await insert('refund', '65.10');
    await assert.rejects(insert('refund', '1.00'), { code: '23505' });
    await assert.rejects(async () => connection`DELETE FROM orders WHERE id = ${orderId}`, {
      constraint_name: 'order_payments_order_id_fkey',
    });

    await connection`DELETE FROM users WHERE id = ${actorId}`;
    const payments = await connection`SELECT recorded_by_user_id FROM order_payments WHERE order_id = ${orderId}`;
    assert.equal(payments.length, 4);
    assert.ok(payments.every(payment => payment.recorded_by_user_id === null));
  } finally {
    if (shopCreated) {
      const [table] = await connection`SELECT to_regclass('public.order_payments') AS name`;
      if (table?.name) await connection`DELETE FROM order_payments WHERE order_id = ${orderId}`;
      await connection`DELETE FROM shops WHERE id = ${shopId}`;
      await connection`DELETE FROM users WHERE id = ${actorId}`;
    }
    await connection.end();
  }
});

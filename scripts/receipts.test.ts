/**
 * Receipt delete tests for N-107.
 *
 * These drive the real `receiptRoutes` over a Fastify instance whose guards are
 * stubbed (`scripts/support/receiptsApp.ts`). `request.receiptsDeps` swaps in a
 * `FakeDb` and a recording stand-in for R2 cleanup, so no query or network call
 * is live. What is asserted is the decision the route makes per status, the
 * statements it issues to carry that decision out, and the schema facts the
 * whole design leans on — a cascade that is no longer a cascade deletes nothing,
 * and a soft-delete column that does not exist cannot be used by mistake.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { FakeDb } from './support/fakeDb.js';
import { buildReceiptsApp, SHOP_ID } from './support/receiptsApp.js';
import { receiptItems, receipts } from '../src/db/schema/index.js';

const RECEIPT_ID = '55555555-5555-5555-5555-555555555555';
const STORAGE_PATH = `${SHOP_ID}/receipts/uploaded.jpg`;

/** Every status upstream of verification: no stock moved, no spend booked. */
const DELETABLE_STATUSES = ['pending', 'processing', 'unverified', 'failed'] as const;

async function harness(
  responses: Record<string, unknown[]> = {},
  options: { deleteFails?: boolean } = {},
) {
  const db = new FakeDb(responses);
  const app = await buildReceiptsApp();
  const deleted: string[] = [];
  app.use({
    db: db as never,
    deleteObject: async (key: string) => {
      deleted.push(key);
      if (options.deleteFails) throw new Error('R2 unreachable');
    },
  });

  return {
    db,
    deleted,
    async del(url: string) {
      const response = await app.app.inject({ method: 'DELETE', url });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => app.close(),
  };
}

/** The `ON DELETE` action Postgres takes for one column's foreign key. */
function onDeleteOf(table: PgTable, columnName: string): string | null {
  for (const foreignKey of getTableConfig(table).foreignKeys) {
    const reference = foreignKey.reference();
    if (reference.columns.some((column) => column.name === columnName)) {
      return foreignKey.onDelete ?? 'no action';
    }
  }
  return null;
}

test('DELETE /receipts/:id hard-removes every status that has not been verified', async () => {
  for (const status of DELETABLE_STATUSES) {
    const h = await harness({
      'select:receipts': [[{ id: RECEIPT_ID, status, storagePath: STORAGE_PATH }]],
    });
    try {
      const { status: code, body } = await h.del(`/api/v1/receipts/${RECEIPT_ID}`);

      assert.equal(code, 200, `${status} should be deletable`);
      assert.equal(body.ok, true);
      assert.deepEqual(
        h.db.callSequence(),
        ['select:receipts', 'delete:receipts'],
        `${status}: one locked read, one delete, nothing else`,
      );
      assert.deepEqual(
        h.deleted,
        [STORAGE_PATH],
        `${status}: the uploaded object goes with the row`,
      );
    } finally {
      await h.close();
    }
  }
});

test('DELETE /receipts/:id refuses a verified receipt with 409 and changes nothing', async () => {
  const h = await harness({
    'select:receipts': [[{ id: RECEIPT_ID, status: 'verified', storagePath: STORAGE_PATH }]],
  });
  try {
    const { status, body } = await h.del(`/api/v1/receipts/${RECEIPT_ID}`);

    assert.equal(status, 409);
    assert.equal(body.error.code, 'CONFLICT');
    assert.match(body.error.message, /verified/i);
    assert.deepEqual(
      h.db.calls.map((call) => `${call.op}:${call.table}`),
      ['select:receipts'],
      'a verified receipt is read and left alone',
    );
    assert.deepEqual(h.deleted, [], 'the object behind it stays too');
  } finally {
    await h.close();
  }
});

test('DELETE /receipts/:id reads a receipt this shop does not own as 404', async () => {
  const h = await harness({ 'select:receipts': [[]] });
  try {
    const { status, body } = await h.del(`/api/v1/receipts/${RECEIPT_ID}`);

    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.deepEqual(h.db.callsTo('delete', 'receipts'), []);
    assert.deepEqual(h.deleted, []);
  } finally {
    await h.close();
  }
});

test('DELETE /receipts/:id keeps the delete when the object cleanup fails', async () => {
  const h = await harness(
    { 'select:receipts': [[{ id: RECEIPT_ID, status: 'unverified', storagePath: STORAGE_PATH }]] },
    { deleteFails: true },
  );
  try {
    const { status, body } = await h.del(`/api/v1/receipts/${RECEIPT_ID}`);

    // The row is already gone: reporting a failure would only invite a retry
    // that now 404s, while the object leak stays either way.
    assert.equal(status, 200, 'an unreachable bucket must not resurrect the receipt');
    assert.equal(body.ok, true);
    assert.deepEqual(h.deleted, [STORAGE_PATH], 'the cleanup was attempted');
    assert.equal(h.db.callsTo('delete', 'receipts').length, 1);
  } finally {
    await h.close();
  }
});

test('receipt lines ride the receipt row down through the FK cascade', () => {
  // The delete issues a single statement; if this ever stops being a cascade
  // the lines would linger silently instead of failing the request.
  assert.equal(onDeleteOf(receiptItems, 'receipt_id'), 'cascade');
});

test('receipts carry no soft-delete state to fall back on', () => {
  // `status` is the lifecycle, not a tombstone: there is no deleted/is_active
  // escape hatch, so a receipt is either present or gone.
  const columns = getTableConfig(receipts).columns.map((column) => column.name);
  assert.equal(columns.includes('deleted_at'), false);
  assert.equal(columns.includes('is_active'), false);
  assert.equal(columns.includes('status'), true);
});

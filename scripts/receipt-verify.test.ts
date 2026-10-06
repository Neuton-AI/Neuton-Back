/**
 * `POST /receipts/:id/verify` tests for N-27 and N-28.
 *
 * Two layers, because the guarantees split cleanly:
 *
 * 1. Route-level cases drive the real handler over a Fastify instance whose auth
 *    guards are stubbed (`scripts/support/receiptsApp.ts`) and whose database is
 *    a `FakeDb`. These pin the decisions: which lines create inventory, how much
 *    stock a verdict moves, what gets written to `receipt_items`, the 409, and
 *    that a mid-transaction failure rolls the whole thing back.
 *
 * 2. Concurrency cases need real Postgres row locks, which no double can model.
 *    They run against the configured `DATABASE_URL` and skip themselves when only
 *    the CI placeholder is present — the same arrangement as
 *    `scripts/signed-download.test.ts`.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import { isPlaceholder } from './support/testEnv.js';
import { FakeDb, type FakeResponses } from './support/fakeDb.js';
import { buildReceiptsApp, SHOP_ID, USER_ID } from './support/receiptsApp.js';
import { db as liveDb } from '../src/db/client.js';
import {
  inventoryItems,
  profiles,
  receiptItems,
  receipts,
  shops,
} from '../src/db/schema/index.js';
import type { ReceiptsDeps } from '../src/routes/receipts.js';
import { verifyReceipt } from '../src/lib/verifyReceipt.js';

const RECEIPT_ID = '44444444-4444-4444-4444-444444444444';
const LINE_A = '55555555-5555-5555-5555-555555555555';
const LINE_B = '66666666-6666-6666-6666-666666666666';

interface StoredLine {
  id: string;
  shopId: string;
  receiptId: string;
  inventoryItemId: string | null;
  rawName: string;
  rawSku: string | null;
  quantity: string | null;
  unitPrice: string | null;
  totalPrice: string | null;
  unit: string | null;
  confidence: string | null;
  reviewStatus: string;
}

function storedLine(overrides: Partial<StoredLine> = {}): StoredLine {
  return {
    id: LINE_A,
    shopId: SHOP_ID,
    receiptId: RECEIPT_ID,
    // Exactly what the worker writes since N-28: extracted, not linked.
    inventoryItemId: null,
    rawName: 'Flour',
    rawSku: null,
    quantity: '2.000',
    unitPrice: '3.5000',
    totalPrice: '7.00',
    unit: 'kg',
    confidence: '0.900',
    reviewStatus: 'pending',
    ...overrides,
  };
}

/**
 * Scripted rows for one accepted line against an existing SKU. The inventory
 * read queue is the lookup's exact hit, then the locked snapshot the apply step
 * reads.
 */
const ONE_ACCEPTED: FakeResponses = {
  'select:receipts': [[{ id: RECEIPT_ID, status: 'unverified', errorMessage: 'boom' }]],
  'select:receiptItems': [[storedLine()]],
  // First read is `findOrCreateInventoryItem`'s exact hit, second is the row the
  // apply step holds the lock on. `lockInventoryRows` keys its snapshots by id,
  // so the locked row has to carry one.
  'select:inventoryItems': [
    [{ id: 'inv-flour' }],
    [{ id: 'inv-flour', currentQuantity: '10.000', averageUnitCost: '2.0000' }],
  ],
};

async function harness(responses: FakeResponses = {}) {
  const fake = new FakeDb(responses);
  const app = await buildReceiptsApp();
  app.use({ db: fake as never } satisfies ReceiptsDeps);

  return {
    fake,
    async post(body: unknown) {
      const response = await app.app.inject({
        method: 'POST',
        url: `/api/v1/receipts/${RECEIPT_ID}/verify`,
        payload: body as object,
      });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => app.close(),
  };
}

/** The reviewer accepts 5 kg of a line whose extraction read 2 kg. */
const CORRECT_UP = { id: LINE_A, accepted: true, quantity: 5 };

// ---------------------------------------------------------------------------
// Decisions: what creates inventory, what moves stock
// ---------------------------------------------------------------------------

test('verify: an accepted line applies the reviewer quantity in full', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  const response = await post({ items: [CORRECT_UP] });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    receiptId: RECEIPT_ID,
    status: 'verified',
    accepted: 1,
    rejected: 0,
  });

  // Nothing was in stock to net out against: the worker extracted these 2 kg but
  // never applied them, so all 5 accepted kg go in. Netting out the extraction
  // (the old delta) would have under-bought the receipt by the 2 kg on the paper.
  const update = fake.onlyCallTo('update', 'inventoryItems');
  const patch = update.set as Record<string, unknown>;
  assert.equal(patch.currentQuantity, '15.000', '10 kg on hand + 5 kg accepted');
  assert.equal(patch.averageUnitCost, '2.5000', '(10 × 2.00 + 5 × 3.50) ÷ 15');
  assert.ok(update.inTransaction, 'inventory writes must run inside the transaction');

  await close();
});

test('verify: accepting a line unchanged still buys exactly what the paper says', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  const response = await post({ items: [{ id: LINE_A, accepted: true }] });

  assert.equal(response.status, 200);
  // Omitting a quantity means "the extraction was right", so the 2 kg read off
  // the document is what lands. Since the worker applied none of it, doing
  // nothing here would be the same bug in the opposite direction.
  const update = fake.onlyCallTo('update', 'inventoryItems');
  const patch = update.set as Record<string, unknown>;
  assert.equal(patch.currentQuantity, '12.000', '10 kg on hand + 2 kg extracted');
  assert.equal(patch.averageUnitCost, '2.2500', '(10 × 2.00 + 2 × 3.50) ÷ 12');

  await close();
});

test('verify: a downward correction is a purchase of the smaller amount, not a removal', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  const response = await post({ items: [{ id: LINE_A, accepted: true, quantity: 1 }] });

  assert.equal(response.status, 200);
  // The extraction said 2 kg, the reviewer says 1 kg, and neither has ever been
  // applied — so this is a 1 kg purchase arriving, not 1 kg walking back out.
  const update = fake.onlyCallTo('update', 'inventoryItems');
  const patch = update.set as Record<string, unknown>;
  assert.equal(patch.currentQuantity, '11.000', '10 kg on hand + 1 kg accepted');
  assert.equal(patch.averageUnitCost, '2.1364', '(10 × 2.00 + 1 × 3.50) ÷ 11');

  await close();
});

test('verify: a rejected line creates no inventory item and moves no stock', async () => {
  const { fake, post, close } = await harness({
    'select:receipts': [[{ id: RECEIPT_ID, status: 'unverified' }]],
    'select:receiptItems': [[storedLine({ rawName: 'Mystery Herb' })]],
  });

  const response = await post({ items: [{ id: LINE_A, accepted: false }] });

  assert.equal(response.status, 200);
  assert.equal(response.body.rejected, 1);
  assert.equal(fake.callsTo('insert', 'inventoryItems').length, 0, 'nothing phantom is created');
  assert.equal(fake.callsTo('update', 'inventoryItems').length, 0, 'no stock moves');

  // The line records the verdict and is left unlinked — nobody bought this.
  const line = fake.onlyCallTo('update', 'receiptItems');
  assert.equal(line.set?.inventoryItemId, null);
  assert.equal(line.set?.reviewStatus, 'rejected');

  await close();
});

test('verify: two accepted lines on one SKU both land', async () => {
  // Both lines resolve to the same inventory row, so both are locked once and
  // both apply off the same snapshot. If the second computed from that snapshot
  // instead of from the first line's result, its write would discard line A.
  const bothOnFlour: FakeResponses = {
    'select:receipts': [[{ id: RECEIPT_ID, status: 'unverified' }]],
    'select:receiptItems': [
      [
        storedLine({ id: LINE_A, quantity: '2.000', unitPrice: '3.0000' }),
        storedLine({ id: LINE_B, rawName: 'Flour', quantity: '0.000', unitPrice: '1.0000' }),
      ],
    ],
    // One exact-hit lookup per line, then the single batched lock read.
    'select:inventoryItems': [
      [{ id: 'inv-flour' }],
      [{ id: 'inv-flour' }],
      [{ id: 'inv-flour', currentQuantity: '10.000', averageUnitCost: '2.0000' }],
    ],
  };
  const { fake, post, close } = await harness(bothOnFlour);

  const response = await post({
    items: [
      { id: LINE_A, accepted: true, quantity: 4, unitPrice: 3 },
      { id: LINE_B, accepted: true, quantity: 6, unitPrice: 1 },
    ],
  });

  assert.equal(response.status, 200);
  const writes = fake.callsTo('update', 'inventoryItems');
  assert.equal(writes.length, 2);
  // 10 kg at 2.00, then +4 kg at 3.00 → 14 kg at 2.2857…
  assert.equal((writes[0]?.set as Record<string, unknown>).currentQuantity, '14.000');
  assert.equal((writes[0]?.set as Record<string, unknown>).averageUnitCost, '2.2857');
  // …and that result, not the original snapshot, is what the second line builds on.
  assert.equal((writes[1]?.set as Record<string, unknown>).currentQuantity, '20.000');
  assert.equal((writes[1]?.set as Record<string, unknown>).averageUnitCost, '1.9000');

  await close();
});

test('verify: every write happens inside one transaction', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  await post({ items: [CORRECT_UP] });

  assert.equal(fake.transactionCount, 1);
  for (const call of fake.calls) {
    assert.ok(call.inTransaction, `${call.op}:${call.table} escaped the transaction`);
  }

  await close();
});

test('verify: a failure mid-transaction leaves no partial inventory writes', async () => {
  const fake = new FakeDb(ONE_ACCEPTED);
  // The line write is the last statement before the receipt header. Failing it
  // stands in for the transaction aborting after stock has already moved.
  fake.failOn('update', 'receiptItems', new Error('connection reset'));
  const app = await buildReceiptsApp();
  app.use({ db: fake as never } satisfies ReceiptsDeps);

  const response = await app.app.inject({
    method: 'POST',
    url: `/api/v1/receipts/${RECEIPT_ID}/verify`,
    payload: { items: [CORRECT_UP] },
  });

  assert.equal(response.statusCode, 500);
  // Postgres discards the whole transaction, so the inventory update that ran
  // before the failure is never committed — the guarantee a `FakeDb` can only
  // assert by proxy: it was inside the transaction that threw.
  const inventoryWrite = fake.onlyCallTo('update', 'inventoryItems');
  assert.ok(inventoryWrite.inTransaction);
  assert.equal(fake.transactionCount, 1);
  // And the receipt header is never stamped verified.
  assert.equal(fake.callsTo('update', 'receipts').filter((c) => c.set?.status === 'verified').length, 0);

  await app.close();
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('verify: a second verification of the same receipt is refused with 409', async () => {
  const { fake, post, close } = await harness({
    ...ONE_ACCEPTED,
    'select:receipts': [[{ id: RECEIPT_ID, status: 'verified', verifiedBy: USER_ID }]],
  });

  const response = await post({ items: [{ id: LINE_A, accepted: true }] });

  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /already verified/);
  // Zero stock movement on the retry is what makes the endpoint safe to retry.
  assert.equal(fake.callsTo('update', 'inventoryItems').length, 0);
  assert.equal(fake.callsTo('update', 'receipts').length, 0);

  await close();
});

test('verify: the receipt row lock is taken before the status is read', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  await post({ items: [CORRECT_UP] });

  // `for update` on the receipt makes the 409 atomic instead of a check-then-act
  // race two parallel requests could both pass.
  const locked = fake.callsTo('select', 'receipts');
  assert.equal(locked.length, 1);
  assert.ok(locked[0]?.inTransaction);

  await close();
});

// ---------------------------------------------------------------------------
// The receipt and its lines
// ---------------------------------------------------------------------------

test('verify: the header records who verified it and when', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  await post({ items: [CORRECT_UP] });

  const patch = fake.onlyCallTo('update', 'receipts').set as Record<string, unknown>;
  assert.equal(patch.status, 'verified');
  assert.equal(patch.verifiedBy, USER_ID);
  assert.ok(patch.verifiedAt instanceof Date, 'verified_at must be stamped');
  assert.equal(patch.errorMessage, null, 'a previous failure message must be cleared');

  await close();
});

test('verify: corrections land and omitted fields keep the extracted value', async () => {
  const { fake, post, close } = await harness(ONE_ACCEPTED);

  await post({
    items: [
      { id: LINE_A, accepted: true, quantity: 5, unitPrice: 4, rawSku: 'SKU-9', totalPrice: 20 },
    ],
  });

  const patch = fake.onlyCallTo('update', 'receiptItems').set as Record<string, unknown>;
  assert.equal(patch.quantity, '5.000');
  assert.equal(patch.unitPrice, '4.0000');
  assert.equal(patch.totalPrice, '20.00');
  // Nothing has ever written this column; a review is the first thing that does.
  assert.equal(patch.rawSku, 'SKU-9');
  assert.equal(patch.reviewStatus, 'accepted');
  assert.equal('rawName' in patch, false, 'an uncorrected field must not be rewritten');
  assert.equal('unit' in patch, false);

  await close();
});

test('verify: a line from another receipt is rejected', async () => {
  const { post, close } = await harness(ONE_ACCEPTED);

  const response = await post({ items: [{ id: LINE_B, accepted: true, quantity: 5 }] });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /does not belong to this receipt/);

  await close();
});

test('verify: a missing receipt is a 404 and an empty item list is a 400', async () => {
  const missing = await harness({ 'select:receipts': [[]] });
  assert.equal((await missing.post({ items: [CORRECT_UP] })).status, 404);
  await missing.close();

  const empty = await harness(ONE_ACCEPTED);
  assert.equal((await empty.post({ items: [] })).status, 400);
  await empty.close();
});

// ---------------------------------------------------------------------------
// Concurrency — real Postgres row locks
// ---------------------------------------------------------------------------

const hasDatabase = !isPlaceholder('DATABASE_URL');
const namespace = `n77-${Date.now().toString(36)}`;

/**
 * `receipts.verified_by` is a foreign key onto `profiles`, and `profiles.id` is
 * itself a foreign key onto `auth.users`, so no id can be minted here — the row
 * has to be one that already exists. Any profile will do: verification records
 * an approver, it does not check one.
 */
const existingProfile = hasDatabase
  ? (
      await liveDb
        .select({ id: profiles.id })
        .from(profiles)
        .orderBy(profiles.createdAt)
        .limit(1)
    )[0]?.id ?? null
  : null;

const VERIFIER_ID = existingProfile ?? USER_ID;

const skip = !hasDatabase
  ? 'no real DATABASE_URL configured (CI) — row-lock concurrency cases skipped'
  : !existingProfile
    ? 'no profiles row to satisfy receipts_verified_by — row-lock cases skipped'
    : false;

/** A shop plus inventory rows, all tagged so cleanup can find them again. */
async function seedInventory(
  lines: Array<{ name: string; quantity: string; averageUnitCost: string }>,
): Promise<{ shopId: string; items: Map<string, string> }> {
  const [shop] = await liveDb
    .insert(shops)
    .values({ name: namespace, slug: namespace })
    .returning({ id: shops.id });

  const created = await liveDb
    .insert(inventoryItems)
    .values(
      lines.map((line) => ({
        shopId: shop!.id,
        name: line.name,
        unit: 'kg' as const,
        currentQuantity: line.quantity,
        averageUnitCost: line.averageUnitCost,
      })),
    )
    .returning({ id: inventoryItems.id, name: inventoryItems.name });

  return {
    shopId: shop!.id,
    items: new Map(created.map((row) => [row.name, row.id])),
  };
}

/**
 * A receipt whose stored lines carry `extractedQuantity` — the figure the vision
 * worker read off the document. Since N-28 the worker saves that and moves
 * nothing, so verification is the first and only thing to touch stock, and it
 * must apply the reviewer's quantity in full.
 */
async function seedReceipt(
  shopId: string,
  lines: Array<{ name: string; quantity: string; unitPrice: string }>,
) {
  const [receipt] = await liveDb
    .insert(receipts)
    .values({
      shopId,
      status: 'unverified',
      progressStage: 'completed',
      // `receipts_scanned_or_manual_check` demands a storage path or a complete
      // manual header. Nothing else on the row matters to these tests.
      storagePath: `${namespace}/${randomUUID()}.png`,
    })
    .returning({ id: receipts.id });

  const inserted = await liveDb
    .insert(receiptItems)
    .values(
      lines.map((line) => ({
        shopId,
        receiptId: receipt!.id,
        inventoryItemId: null,
        rawName: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unit: 'kg',
      })),
    )
    .returning({ id: receiptItems.id });

  return { receiptId: receipt!.id, lineIds: inserted.map((row) => row.id) };
}

/**
 * Runs the endpoint's real verification logic directly against Postgres.
 *
 * The Fastify harness pins one shop, but these cases need two receipts racing for
 * the same SKU rows under different shop contexts, and the point is the row locks
 * — which live in `lockInventoryRows`, not in the guard chain.
 */
function verifyAgainstDatabase(
  shopId: string,
  receiptId: string,
  items: Array<{ id: string; accepted: boolean; quantity?: number; unitPrice?: number }>,
) {
  return verifyReceipt({
    db: liveDb,
    shopId,
    userId: VERIFIER_ID,
    receiptId,
    items,
  });
}

async function cleanup(shopId: string) {
  // Receipts, receipt items and inventory all cascade from the shop.
  await liveDb.delete(shops).where(eq(shops.id, shopId));
}

async function readQuantity(inventoryItemId: string) {
  const rows = await liveDb
    .select({
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId));
  return rows[0]!;
}

test('concurrency: two receipts sharing a SKU verify simultaneously and both count', { skip }, async () => {
  const { shopId, items } = await seedInventory([
    { name: `${namespace}-flour`, quantity: '10.000', averageUnitCost: '2.0000' },
  ]);
  const flourId = items.get(`${namespace}-flour`)!;

  try {
    // Both receipts extracted quantities neither ever applied, so each verdict
    // lands in full: A adds its accepted 5 kg at 3.00, B its 20 kg at 1.00.
    const a = await seedReceipt(shopId, [
      { name: 'flour', quantity: '2.000', unitPrice: '3.0000' },
    ]);
    const b = await seedReceipt(shopId, [
      { name: 'flour', quantity: '1.000', unitPrice: '1.0000' },
    ]);

    await Promise.all([
      verifyAgainstDatabase(shopId, a.receiptId, [{ id: a.lineIds[0]!, accepted: true, quantity: 5, unitPrice: 3 }]),
      verifyAgainstDatabase(shopId, b.receiptId, [{ id: b.lineIds[0]!, accepted: true, quantity: 20, unitPrice: 1 }]),
    ]);

    const row = await readQuantity(flourId);
    // 10 + 5 + 20 = 35 kg: both verdicts counted, and each applied in full
    // rather than as a gap against an extraction nobody had ever applied.
    // Without the row lock the second writer reads the pre-purchase quantity and
    // overwrites the first's contribution: 30 kg at 1.3333, five kg silently gone.
    assert.equal(row.currentQuantity, '35.000');
    assert.equal(row.averageUnitCost, '1.5714');

    // Both receipts really did verify; neither was lost to a retry error.
    const statuses = await liveDb
      .select({ id: receipts.id, status: receipts.status })
      .from(receipts)
      .where(and(eq(receipts.shopId, shopId)));
    assert.equal(statuses.length, 2);
    assert.deepEqual(statuses.map((r) => r.status), ['verified', 'verified']);
  } finally {
    await cleanup(shopId);
  }
});

test('deadlock: two receipts sharing two SKUs in opposite order both succeed', { skip }, async () => {
  const { shopId, items } = await seedInventory([
    { name: `${namespace}-salt`, quantity: '0.000', averageUnitCost: '0.0000' },
    { name: `${namespace}-oil`, quantity: '0.000', averageUnitCost: '0.0000' },
  ]);
  const saltId = items.get(`${namespace}-salt`)!;
  const oilId = items.get(`${namespace}-oil`)!;

  try {
    // Same two SKUs, submitted in opposite order. Locking in body order would
    // have A hold salt wanting oil while B holds oil wanting salt.
    const a = await seedReceipt(shopId, [
      { name: 'salt', quantity: '1.000', unitPrice: '1.0000' },
      { name: 'oil', quantity: '1.000', unitPrice: '2.0000' },
    ]);
    const b = await seedReceipt(shopId, [
      { name: 'oil', quantity: '1.000', unitPrice: '2.0000' },
      { name: 'salt', quantity: '1.000', unitPrice: '1.0000' },
    ]);

    const results = await Promise.allSettled([
      verifyAgainstDatabase(shopId, a.receiptId, [
        { id: a.lineIds[0]!, accepted: true, quantity: 1, unitPrice: 1 },
        { id: a.lineIds[1]!, accepted: true, quantity: 1, unitPrice: 2 },
      ]),
      verifyAgainstDatabase(shopId, b.receiptId, [
        { id: b.lineIds[0]!, accepted: true, quantity: 1, unitPrice: 2 },
        { id: b.lineIds[1]!, accepted: true, quantity: 1, unitPrice: 1 },
      ]),
    ]);

    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled'],
      'both verifications must complete, not one dying on a deadlock',
    );

    const statuses = await liveDb
      .select({ status: receipts.status })
      .from(receipts)
      .where(and(eq(receipts.shopId, shopId)));
    assert.deepEqual(statuses.map((r) => r.status), ['verified', 'verified']);
    assert.equal((await readQuantity(saltId)).currentQuantity, '2.000');
    assert.equal((await readQuantity(oilId)).currentQuantity, '2.000');
  } finally {
    await cleanup(shopId);
  }
});

test('database: a verified receipt records who approved it on the row', { skip }, async () => {
  const { shopId, items } = await seedInventory([
    { name: `${namespace}-honey`, quantity: '0.000', averageUnitCost: '0.0000' },
  ]);
  const honeyId = items.get(`${namespace}-honey`)!;

  try {
    const seeded = await seedReceipt(shopId, [
      { name: 'honey', quantity: '1.000', unitPrice: '5.0000' },
    ]);

    await verifyAgainstDatabase(shopId, seeded.receiptId, [
      { id: seeded.lineIds[0]!, accepted: true, quantity: 2, unitPrice: 5 },
    ]);

    const row = await liveDb
      .select({
        status: receipts.status,
        verifiedBy: receipts.verifiedBy,
        verifiedAt: receipts.verifiedAt,
      })
      .from(receipts)
      .where(eq(receipts.id, seeded.receiptId));

    assert.equal(row[0]?.status, 'verified');
    assert.equal(row[0]?.verifiedBy, VERIFIER_ID);
    assert.ok(row[0]?.verifiedAt instanceof Date);

    // 0 on hand + the 2 accepted kg. The 1 kg the paper claimed was extracted,
    // never applied, so there is nothing to net it out against.
    assert.equal((await readQuantity(honeyId)).currentQuantity, '2.000');

    const lines = await liveDb
      .select({ reviewStatus: receiptItems.reviewStatus })
      .from(receiptItems)
      .where(eq(receiptItems.receiptId, seeded.receiptId));
    assert.equal(lines[0]?.reviewStatus, 'accepted');
  } finally {
    await cleanup(shopId);
  }
});
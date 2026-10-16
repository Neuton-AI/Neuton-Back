import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildReceiptsApp, SHOP_ID } from './support/receiptsApp.js';

const RECEIPT_ID = '55555555-5555-5555-5555-555555555555';
const LINE_ID = '66666666-6666-6666-6666-666666666666';
const INVENTORY_ID = '77777777-7777-7777-7777-777777777777';
const LINE = {
  id: LINE_ID,
  rawName: 'Branded flour 1kg',
  rawMaterialName: 'Wheat flour',
  srcUnit: 'kg',
  quantity: '2.000',
  unitPrice: '3.4567',
  baseUnit: 'g',
  baseUnitAmount: '1000.000',
};
const INVENTORY = {
  id: INVENTORY_ID,
  name: LINE.rawName,
  currentQuantity: '3.000',
  averageUnitCost: '2.0000',
  baseUnit: 'kg',
  baseUnitAmount: '1.00',
};

async function harness(options: {
  line?: Partial<Omit<typeof LINE, 'baseUnit' | 'baseUnitAmount'>> & {
    baseUnit?: string | null;
    baseUnitAmount?: string | null;
  };
  create?: boolean;
  status?: string;
} = {}) {
  const h = await buildReceiptsApp();
  const db = new FakeDb({
    'select:receipts': [[{ id: RECEIPT_ID, status: options.status ?? 'unverified' }]],
    'select:receiptItems': [[{ ...LINE, ...options.line }]],
    'select:inventoryItems': [
      options.create ? [] : [INVENTORY],
      [{ ...INVENTORY, ...(options.create ? { currentQuantity: '0.000', averageUnitCost: '0' } : {}) }],
    ],
    'insert:inventoryItems': [[{ id: INVENTORY_ID }]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  return {
    ...h,
    db,
    verify: (corrections: Record<string, unknown> = {}, accepted = true) => h.app.inject({
      method: 'POST',
      url: `/api/v1/receipts/${RECEIPT_ID}/verify`,
      payload: { items: [{ id: LINE_ID, accepted, ...corrections }] },
    }),
  };
}

test('receipt verification saves extracted material details for new and existing inventory', async () => {
  for (const create of [false, true]) {
    const h = await harness({ create });
    try {
      const response = await h.verify();
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { receiptId: RECEIPT_ID, status: 'verified', accepted: 1, rejected: 0 });
      const writes = h.db.callsTo('update', 'inventoryItems');
      assert.deepEqual(writes[0]?.set, {
        rawMaterialName: 'Wheat flour',
        baseUnit: 'g',
        baseUnitAmount: '1000.00',
        baseUnitCost: '0.003457',
        updatedAt: writes[0]?.set?.updatedAt,
      });
      assert.equal(writes[1]?.set?.currentQuantity, create ? '2.000' : '5.000');
      assert.equal(writes[1]?.set?.averageUnitCost, create ? '3.4567' : '2.5827');
      assert.equal(h.db.callsTo('insert', 'inventoryItems').length, create ? 1 : 0);
      assert.equal(h.db.onlyCallTo('update', 'receiptItems').set?.inventoryItemId, INVENTORY_ID);
      assert.equal(h.db.onlyCallTo('update', 'receipts').set?.status, 'verified');
      assert.ok(h.db.calls.every((call) => call.inTransaction));
      assert.equal(h.db.transactionCount, 1);
    } finally { await h.close(); }
  }
});

test('receipt corrections persist and determine inventory base cost using corrected price and amount', async () => {
  const h = await harness();
  try {
    const response = await h.verify({
      rawMaterialName: '  Bread flour  ', baseUnit: 'kg', baseUnitAmount: 0.5, unitPrice: 6,
    });
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.rawMaterialName, 'Bread flour');
    assert.equal(material?.baseUnit, 'kg');
    assert.equal(material?.baseUnitAmount, '0.50');
    assert.equal(material?.baseUnitCost, '12.000000');
    assert.deepEqual(h.db.onlyCallTo('update', 'receiptItems').set, {
      inventoryItemId: INVENTORY_ID,
      rawMaterialName: 'Bread flour', baseUnit: 'kg', baseUnitAmount: '0.500', unitPrice: '6.0000',
    });
  } finally { await h.close(); }
});

test('explicit base cost corrections keep six decimal places, including zero', async () => {
  for (const [baseUnitCost, expected] of [[0.123456, '0.123456'], [0, '0.000000']] as const) {
    const h = await harness();
    try {
      const response = await h.verify({ baseUnitCost });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(h.db.callsTo('update', 'inventoryItems')[0]?.set?.baseUnitCost, expected);
    } finally { await h.close(); }
  }
});

test('zero amounts and free purchases produce finite zero base costs', async () => {
  for (const corrections of [{ baseUnitAmount: 0 }, { unitPrice: 0 }]) {
    const h = await harness();
    try {
      const response = await h.verify(corrections);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(h.db.callsTo('update', 'inventoryItems')[0]?.set?.baseUnitCost, '0.000000');
    } finally { await h.close(); }
  }
});

test('missing extraction measurements retain the inventory package measurement', async () => {
  const h = await harness({ line: { baseUnit: null, baseUnitAmount: null } });
  try {
    const response = await h.verify();
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnit, 'kg');
    assert.equal(material?.baseUnitAmount, '1.00');
    assert.equal(material?.baseUnitCost, '3.456700');
  } finally { await h.close(); }
});

test('zero-quantity accepted lines still save material details without applying stock', async () => {
  const h = await harness({ line: { quantity: '0.000' } });
  try {
    const response = await h.verify();
    assert.equal(response.statusCode, 200, response.body);
    const writes = h.db.callsTo('update', 'inventoryItems');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.set?.rawMaterialName, 'Wheat flour');
    assert.equal(writes[0]?.set?.baseUnitCost, '0.003457');
    assert.equal(writes[0]?.set?.currentQuantity, undefined);
  } finally { await h.close(); }
});

test('a missing amount cannot reuse a measurement in a different base unit', async () => {
  const h = await harness({ line: { baseUnit: 'g', baseUnitAmount: null } });
  try {
    const response = await h.verify();
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnit, 'g');
    assert.equal(material?.baseUnitAmount, '0.00');
    assert.equal(material?.baseUnitCost, '0.000000');
  } finally { await h.close(); }
});

test('rejected lines save corrections without creating or updating inventory', async () => {
  const h = await harness();
  try {
    const response = await h.verify({ rawMaterialName: 'Bread flour', baseUnit: 'kg', baseUnitAmount: 1 }, false);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(h.db.callsTo('select', 'inventoryItems'), []);
    assert.deepEqual(h.db.callsTo('insert', 'inventoryItems'), []);
    assert.deepEqual(h.db.callsTo('update', 'inventoryItems'), []);
    assert.deepEqual(h.db.onlyCallTo('update', 'receiptItems').set, {
      inventoryItemId: null, rawMaterialName: 'Bread flour', baseUnit: 'kg', baseUnitAmount: '1.000',
    });
  } finally { await h.close(); }
});

test('invalid material corrections are rejected before any database access', async () => {
  const h = await harness();
  try {
    for (const corrections of [
      { rawMaterialName: '' }, { rawMaterialName: '<script>bad</script>' }, { rawMaterialName: 'x'.repeat(161) },
      { baseUnit: '' }, { baseUnit: '<b>kg</b>' }, { baseUnit: 'x'.repeat(25) },
      { baseUnitAmount: -1 }, { baseUnitAmount: null }, { baseUnitAmount: 10000000000 },
      { baseUnitCost: -1 }, { baseUnitCost: null }, { baseUnitCost: 1000000000000 },
    ]) {
      const response = await h.verify(corrections);
      assert.equal(response.statusCode, 400, JSON.stringify(corrections));
    }
    assert.deepEqual(h.db.calls, []);
  } finally { await h.close(); }
});

test('already verified receipts cannot change stock or material details', async () => {
  const h = await harness({ status: 'verified' });
  try {
    const response = await h.verify({ rawMaterialName: 'Changed' });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(h.db.callSequence(), ['select:receipts']);
  } finally { await h.close(); }
});

test('multiple receipt lines for one item preserve every quantity contribution', async () => {
  const h = await buildReceiptsApp();
  const secondId = '88888888-8888-8888-8888-888888888888';
  const db = new FakeDb({
    'select:receipts': [[{ id: RECEIPT_ID, status: 'unverified' }]],
    'select:receiptItems': [[LINE, { ...LINE, id: secondId, unitPrice: '4.0000' }]],
    'select:inventoryItems': [[INVENTORY], [INVENTORY], [INVENTORY]],
  });
  h.use({ db: db as never, deleteObject: async () => {} });
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/receipts/${RECEIPT_ID}/verify`,
      payload: { items: [{ id: LINE_ID, accepted: true }, { id: secondId, accepted: true }] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const writes = db.callsTo('update', 'inventoryItems');
    assert.equal(writes[3]?.set?.currentQuantity, '7.000');
    assert.equal(writes[3]?.set?.averageUnitCost, '2.9876');
    assert.equal(writes[2]?.set?.baseUnitCost, '0.004000');
  } finally { await h.close(); }
});

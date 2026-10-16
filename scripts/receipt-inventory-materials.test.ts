import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildReceiptsApp } from './support/receiptsApp.js';

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
  history?: { baseUnitCost: string; baseUnitAmount: string }[];
} = {}) {
  const h = await buildReceiptsApp();
  const db = new FakeDb({
    'select:receipts': [[{ id: RECEIPT_ID, status: options.status ?? 'unverified' }]],
    'select:receiptItems': [[{ ...LINE, ...options.line }], options.history ?? []],
    'select:inventoryItems': [
      options.create ? [] : [INVENTORY],
      [{ ...INVENTORY, ...(options.create ? { currentQuantity: '0.000', averageUnitCost: '0', baseUnitAmount: '0.000' } : {}) }],
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
        baseUnitAmount: create ? '2000.000' : '3000.000',
        baseUnitCost: '0.003457',
        baseUnitAverageCost: '0.003457',
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
    assert.equal(material?.baseUnitAmount, '2.000');
    assert.equal(material?.baseUnitCost, '12.000000');
    assert.deepEqual(h.db.onlyCallTo('update', 'receiptItems').set, {
      inventoryItemId: INVENTORY_ID,
      rawMaterialName: 'Bread flour', baseUnit: 'kg', baseUnitAmount: '0.500', unitPrice: '6.0000',
      baseUnitCost: '12.000000',
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

test('missing measurements never multiply the existing inventory total as a package amount', async () => {
  const h = await harness({ line: { baseUnit: null, baseUnitAmount: null } });
  try {
    const response = await h.verify();
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnit, 'kg');
    assert.equal(material?.baseUnitAmount, '1.000');
    assert.equal(material?.baseUnitCost, '0.000000');
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
    assert.equal(material?.baseUnitAmount, '1000.000');
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
      { baseUnitAmount: -1 }, { baseUnitAmount: null }, { baseUnitAmount: 1000000000 },
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
    assert.equal(writes[2]?.set?.baseUnitAmount, '5000.000');
    assert.equal(writes[2]?.set?.baseUnitAverageCost, '0.003729');
  } finally { await h.close(); }
});

test('SMA keeps the latest 20 purchase costs and gives large and small purchases equal weight', async () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    baseUnitCost: String(20 - index), baseUnitAmount: '1.000',
  }));
  const h = await harness({ history });
  try {
    const response = await h.verify({ quantity: 100, baseUnitCost: 21 });
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnitAverageCost, '11.500000');
    assert.equal(material?.baseUnitAmount, '101000.000');
    const historyRead = h.db.callsTo('select', 'receiptItems')[1];
    assert.equal(historyRead?.limit, 20);
    assert.deepEqual(historyRead?.joins, ['innerJoin']);
    assert.equal(h.db.onlyCallTo('update', 'receiptItems').set?.baseUnitCost, '21.000000');
  } finally { await h.close(); }
});

test('SMA uses available history, including zero-cost purchases and explicit corrected costs', async () => {
  const h = await harness({ history: [
    { baseUnitCost: '0.000000', baseUnitAmount: '1000.000' },
    { baseUnitCost: '6.000000', baseUnitAmount: '1000.000' },
  ] });
  try {
    const response = await h.verify({ baseUnitCost: 3, quantity: 0.5 });
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnitAverageCost, '3.000000');
    assert.equal(material?.baseUnitAmount, '1500.000');
  } finally { await h.close(); }
});

test('zero-quantity lines leave purchase history unchanged', async () => {
  const h = await harness({ history: [{ baseUnitCost: '6.000000', baseUnitAmount: '1000.000' }] });
  try {
    const response = await h.verify({ quantity: 0, baseUnitCost: 100 });
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnitAverageCost, '6.000000');
    assert.equal(material?.baseUnitAmount, '1000.000');
  } finally { await h.close(); }
});

test('missing package amounts can reuse the latest verified receipt measurement', async () => {
  const h = await harness({
    line: { baseUnitAmount: null },
    history: [{ baseUnitCost: '0.004', baseUnitAmount: '500.000' }],
  });
  try {
    const response = await h.verify({ unitPrice: 3 });
    assert.equal(response.statusCode, 200, response.body);
    const material = h.db.callsTo('update', 'inventoryItems')[0]?.set;
    assert.equal(material?.baseUnitAmount, '2000.000');
    assert.equal(material?.baseUnitCost, '0.006000');
    assert.equal(material?.baseUnitAverageCost, '0.005000');
    assert.equal(h.db.onlyCallTo('update', 'receiptItems').set?.baseUnitAmount, '500.000');
  } finally { await h.close(); }
});

test('duplicate submitted receipt lines fail before inventory can be changed twice', async () => {
  const h = await harness();
  try {
    const response = await h.app.inject({
      method: 'POST', url: `/api/v1/receipts/${RECEIPT_ID}/verify`,
      payload: { items: [{ id: LINE_ID, accepted: true }, { id: LINE_ID, accepted: true }] },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(h.db.callsTo('update', 'inventoryItems'), []);
    assert.deepEqual(h.db.callsTo('update', 'receiptItems'), []);
  } finally { await h.close(); }
});

test('incompatible base unit corrections cannot silently discard existing stock', async () => {
  const h = await harness();
  try {
    const response = await h.verify({ baseUnit: 'ml' });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(h.db.callsTo('update', 'inventoryItems'), []);
  } finally { await h.close(); }
});

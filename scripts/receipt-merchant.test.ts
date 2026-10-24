import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { domainHarness, SHOP_ID } from './support/domainApp.js';

const id = '55555555-5555-5555-5555-555555555555';
const url = `/api/v1/receipts/${id}`;
test('receipt merchant correction persists a trimmed name without changing review status', async () => {
  const row = { id, shopId: SHOP_ID, status: 'unverified', merchantName: 'Market',
    createdAt: new Date(), updatedAt: new Date() };
  const db = new FakeDb({ 'select:receipts': [[row]], 'update:receipts': [[row]] });
  const h = await domainHarness();
  h.use({ db: db as never });
  try {
    const response = await h.app.inject({ method: 'PATCH', url, payload: { merchantName: '  Market  ' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().receipt.merchantName, 'Market');
    assert.equal(response.json().receipt.status, 'unverified');
    const values = db.onlyCallTo('update', 'receipts').set as Record<string, unknown>;
    assert.equal(values.merchantName, 'Market');
    assert.equal('status' in values, false);
  } finally { await h.close(); }
});

test('merchant correction rejects unauthorized roles, invalid fields, and unavailable receipts', async () => {
  for (const [role, payload, rows, expected] of [
    ['member', { merchantName: 'Market' }, [], 403],
    ['owner', { merchantName: ' ' }, [], 400],
    ['owner', { merchantName: '<script>x</script>' }, [], 400],
    ['owner', { merchantName: 'Market', status: 'verified' }, [], 400],
    ['owner', { merchantName: 'Market' }, [], 404],
    ['owner', { merchantName: 'Market' }, [{ status: 'processing' }], 409],
  ] as const) {
    const db = new FakeDb({ 'select:receipts': [[...rows]] });
    const h = await domainHarness(role);
    h.use({ db: db as never });
    try {
      const response = await h.app.inject({ method: 'PATCH', url, payload });
      assert.equal(response.statusCode, expected, JSON.stringify({ role, payload, body: response.body }));
      assert.equal(db.callsTo('update', 'receipts').length, 0);
    } finally { await h.close(); }
  }
});

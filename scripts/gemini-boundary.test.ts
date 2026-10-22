import './support/testEnv.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

process.env.GEMINI_MODELS = 'boundary-first,boundary-fallback';
const { extractReceipt, extractRecipe, extractOrder } = await import('../src/lib/gemini.js');
const document = { mimeType: 'image/png', data: 'dGVzdA==' };

function provider(t: TestContext, payloads: unknown[]) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(calls < payloads.length, 'unexpected model attempt');
    const text = JSON.stringify(payloads[calls++]);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return () => calls;
}

for (const invalid of [null, {}, { items: null }, { items: {} }, { items: [null] }, { items: ['milk'] }]) {
  test(`receipt falls back after invalid structure ${JSON.stringify(invalid)}`, async (t) => {
    const calls = provider(t, [invalid, { merchantName: 'Fallback', items: [] }]);
    assert.equal((await extractReceipt(document))?.merchantName, 'Fallback');
    assert.equal(calls(), 2);
  });
}

test('receipt divides normalized currency values and never returns non-finite prices', async (t) => {
  provider(t, [{ items: [
    { rawName: '<b>Milk</b>', quantity: '2', totalPrice: '₪12.90', baseUnit: 'ml' },
    { quantity: 0, totalPrice: 10, baseUnit: 'invented-unit' },
    { quantity: null, totalPrice: 10 },
    { quantity: 1e-308, totalPrice: 1e308 },
    { quantity: 2, totalPrice: 0 },
  ] }]);
  const receipt = await extractReceipt(document);
  assert.ok(receipt);
  assert.equal(receipt.items[0]?.rawName, 'Milk');
  assert.equal(receipt.items[0]?.unitPrice, 6.45);
  assert.equal(receipt.items[0]?.baseUnit, 'ml');
  assert.equal(receipt.items[1]?.baseUnit, null);
  assert.deepEqual(receipt.items.map((item) => item.unitPrice), [6.45, null, null, null, 0]);
  assert.equal(receipt.items[2]?.baseUnit, null);
});

for (const [kind, extract, collection] of [
  ['recipe', extractRecipe, 'ingredients'], ['order', extractOrder, 'items'],
] as const) {
  for (const invalid of [null, [], { [collection]: {} }, { [collection]: [null] }]) {
    test(`${kind} falls back after invalid structure ${JSON.stringify(invalid)}`, async (t) => {
      const calls = provider(t, [invalid, { name: 'Bread', customerName: 'Customer', [collection]: [] }]);
      const result = await extract(document);
      assert.ok(result);
      assert.equal(calls(), 2);
    });
  }
}

test('exhausted structurally invalid model responses reject the extraction', async (t) => {
  const calls = provider(t, [{}, { items: [null] }]);
  await assert.rejects(extractReceipt(document));
  assert.equal(calls(), 2);
});

test('recipe and order preserve tolerant scalar normalization and optional collections', async (t) => {
  provider(t, [{ name: '<b>Bread</b>', prepTimeMinutes: '30', ingredients: [{ quantity: '2' }] }, {}]);
  const recipe = await extractRecipe(document);
  assert.equal(recipe?.name, 'Bread');
  assert.equal(recipe?.prepTimeMinutes, 30);
  assert.equal(recipe?.ingredients[0]?.rawName, 'Unknown ingredient');
  assert.deepEqual(recipe?.steps, []);
  assert.deepEqual((await extractOrder(document))?.items, []);
});

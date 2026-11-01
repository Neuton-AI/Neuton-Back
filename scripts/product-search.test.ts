import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichReciptItems, getValidNameEnrichment } from '../src/lib/supermarket/product-search.js';
import { priceResult } from './support/priceResult.js';
import type { ReceiptExtraction } from '../src/lib/gemini.js';

function receipt(rawSku: string | null = null): ReceiptExtraction {
  return { items: [{ rawSku, rawName: 'Receipt milk', rawMaterialName: 'Milk' }] } as ReceiptExtraction;
}

test('receipt tries exact SKU before names and uses explicit SKU query type', async () => {
  const result = await enrichReciptItems(receipt('00123'), async (q, type) => {
    assert.equal(q, '00123');
    assert.equal(type, 'sku');
    return [priceResult({ itemCode: '00123' })];
  });
  assert.equal(result[0]?.item.isSkuEnriched, true);
  assert.equal(result[0]?.itemEnrichment?.[0]?.itemCode, '00123');
});

test('exact name match stops fallback; null and partial names do not qualify', async () => {
  const exact = priceResult({ itemName: 'RECEIPT MILK' });
  const result = await enrichReciptItems(receipt(), async (q, type) => {
    assert.equal(q, 'Receipt milk'); assert.equal(type, 'name');
    return [priceResult({ itemName: null }), priceResult({ itemName: 'Receipt milk fresh' }), exact];
  });
  assert.deepEqual(result[0]?.itemEnrichment, [exact]);
  assert.equal(result[0]?.item.isSkuEnriched, false);
  assert.deepEqual(await getValidNameEnrichment('Milk', async () => [priceResult({ itemName: null })]), []);
});

test('fallback merges both names, orders API scores, and keeps five including duplicate products', async () => {
  const queries: string[] = [];
  const raw = [priceResult({ itemCode: 'a', score: 30 }), priceResult({ itemCode: 'b', score: 10 })];
  const material = [priceResult({ itemCode: 'c', score: 50 }), priceResult({ itemCode: 'a', score: 40 }),
    priceResult({ itemCode: 'd', score: 20 }), priceResult({ itemCode: 'e', score: 1 })];
  const result = await enrichReciptItems(receipt(), async (q, type) => {
    assert.equal(type, 'name'); queries.push(q);
    return q === 'Receipt milk' ? raw : material;
  });
  assert.deepEqual(queries, ['Receipt milk', 'Receipt milk', 'Milk']);
  assert.deepEqual(result[0]?.itemEnrichment?.map(row => [row.itemCode, row.score]),
    [['c', 50], ['a', 40], ['a', 30], ['d', 20], ['b', 10]]);
});

test('receipt remains processable when search fails; a successful alternate name still enriches', async () => {
  for (const partialSuccess of [false, true]) {
    const result = await enrichReciptItems(receipt('00123'), async q => {
      if (partialSuccess && q === 'Milk') return [priceResult()];
      throw new Error('API unavailable');
    });
    assert.equal(result[0]?.item.isSkuEnriched, false);
    assert.deepEqual(result[0]?.itemEnrichment, partialSuccess ? [priceResult()] : []);
  }
});

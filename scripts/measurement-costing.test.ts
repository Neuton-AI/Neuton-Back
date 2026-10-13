import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCatalogMeasurement, isFoodCandidate } from '../src/lib/supermarket/measurements.js';
import { parseXmlItems, selectExactProduct, lookupExactProduct } from '../src/lib/supermarket/prices.js';
import { productMeasurementKey } from '../src/lib/productIdentity.js';
import { costNormalizedRecipe, type CostingLine } from '../src/lib/recipeCosting.js';
import { verifyReceipt } from '../src/lib/verifyReceipt.js';
import { FakeDb } from './support/fakeDb.js';
import type { Database } from '../src/db/client.js';

const recipe = { prepTimeMinutes: 0, yieldQuantity: 1 };
const butter: CostingLine = { rawName: 'butter', quantity: 50, unit: 'g', inventoryItemId: null, generalPriceId: 'offer',
  currentQuantity: null, averageUnitCost: null, packageQuantity: '250', packageUnit: 'g', priceIls: '10', priceStatus: 'ready' };
test('package cost is proportional, estimates are labeled and missing costs are null', () => {
  const cost = costNormalizedRecipe(recipe, [butter], '30', '0');
  assert.equal(cost.unitCost, 2); assert.equal(cost.measurementState, 'estimated'); assert.equal(cost.inStock, false);
  const missing = costNormalizedRecipe(recipe, [butter, { ...butter, quantity: null }], '30', '0');
  assert.equal(missing.unitCost, null); assert.equal(missing.retailPrice, null); assert.equal(missing.knownSubtotal, 2);
  assert.equal(missing.ingredients[1]?.lineCost, null);
  assert.equal(costNormalizedRecipe({ ...recipe, yieldQuantity: 0 }, [butter], '0', '0').unitCost, null);
  assert.equal(costNormalizedRecipe(recipe, [{ ...butter, priceIls: '0' }], '0', '0').unitCost, 0);
  assert.equal(costNormalizedRecipe(recipe, [{ ...butter, packageQuantity: '.25', packageUnit: 'kg' }], '0', '0').unitCost, 2);
  assert.equal(costNormalizedRecipe(recipe, [{ ...butter, currency: 'USD' }], '0', '0').unitCost, null);
  assert.equal(costNormalizedRecipe(recipe, [{ ...butter, priceStatus: 'unresolved', measurementContext: {
    catalogPackage: { quantity: 250, unit: 'g', source: 'user', version: 'v1' },
  } }], '0', '0').unitCost, 2);
});
test('stock requirements aggregate repeated lines in a compatible unit', () => {
  const line = { ...butter, inventoryItemId: 'stock', generalPriceId: null, inventoryUnit: 'g', inventoryStatus: 'ready', averageUnitCost: '.04', currentQuantity: '75' };
  const cost = costNormalizedRecipe(recipe, [line, line], '0', '0');
  assert.equal(cost.unitCost, 4); assert.equal(cost.inStock, false); assert.equal(cost.stockRequirements[0]?.requiredQuantity, 100);
  assert.equal(costNormalizedRecipe(recipe, [{ ...line, quantity: .05, unit: 'kg' }], '0', '0').unitCost, 2);
  assert.equal(costNormalizedRecipe(recipe, [{ ...line, rawName: 'unknown', unit: 'fl oz', measurementContext: { convention: 'us' } }], '0', '0').unitCost, null);
  assert.equal(costNormalizedRecipe(recipe, [{ ...line, inventoryStatus: 'legacy_reconciliation_required' }], '0', '0').unitCost, null);
});
test('source adapter distinguishes supplied gouda, vodka, cheddar and belt records', () => {
  const gouda = { ItemName: 'גבינת גאודה 200 גרם.', ItemPrice: '30.20', Quantity: '200', UnitQty: 'גרם', UnitOfMeasure: '100 גרם', UnitOfMeasurePrice: '15.10', bIsWeighted: '0', QtyInPackage: 'לא ידוע' };
  assert.deepEqual(resolveCatalogMeasurement(gouda).measurement, { quantity: 200, unit: 'g' });
  const vodka = resolveCatalogMeasurement({ ItemName: 'וודקה חורטיצה קלאסיק 700', ItemPrice: '69.90', Quantity: '700', UnitOfMeasure: '100 מיליליטר', UnitOfMeasurePrice: '9.99' });
  assert.deepEqual(vodka.measurement, { quantity: 700, unit: 'ml' });
  assert.equal(Math.round(30 / 700 * 69.9 * 100) / 100, 3);
  assert.equal(resolveCatalogMeasurement({ ...gouda, ItemName: 'שביק גבינת צדר אנגלי', UnitQty: 'ליטר', UnitOfMeasure: 'ליטר 1', UnitOfMeasurePrice: '.12', ItemPrice: '24.90' }).state, 'unresolved');
  assert.equal(isFoodCandidate('חגורה מהודרת'), false);
  const [record] = parseXmlItems('<Item><ItemCode>00123456</ItemCode><ItemName>Milk</ItemName><ManufactureName>Farm</ManufactureName><ItemPrice>6</ItemPrice><Quantity>1</Quantity><UnitQty>ליטר</UnitQty></Item>');
  assert.equal(record?.ItemCode, '00123456'); assert.equal(record?.ManufacturerName, 'Farm'); assert.equal(record?.UnitQty, 'ליטר');
  assert.equal(selectExactProduct([{ chain: 'shufersal', name: 'milk', price: 6, barcode: '00123456', score: 10000 }], '123456'), null);
  assert.equal(selectExactProduct([{ chain: 'shufersal', name: 'milk', price: 6, barcode: '123', score: 10000 }], '123'), null);
});
test('deferred purchase applies normalized stock once and preserves paid amount', async () => {
  const line = { id: 'line', rawName: 'butter', rawSku: null, quantity: '2', unit: 'pack', unitPrice: '10', totalPrice: '20', applicationStatus: 'pending', reviewStatus: 'accepted' };
  const db = new FakeDb({ 'select:receiptItems': [[line], [line]], 'select:receipts': [[{ id: 'receipt', status: 'verified', currency: 'ILS' }]],
    'select:inventoryItems': [[], [{ id: 'inv', currentQuantity: '0', averageUnitCost: null, unit: 'g', measurementStatus: 'ready' }]], 'insert:inventoryItems': [[{ id: 'inv' }]] });
  const result = await verifyReceipt({ db: db as unknown as Database, shopId: 'shop', userId: 'user', receiptId: 'receipt', deferred: true,
    lookup: async () => null, items: [{ id: 'line', accepted: true, packageQuantity: 250, packageUnit: 'g' }] });
  assert.equal(result.applied, 1); assert.equal(result.pending, 0);
  assert.equal(db.onlyCallTo('update', 'inventoryItems').set?.currentQuantity, '500.000000');
  assert.equal(db.onlyCallTo('update', 'inventoryItems').set?.averageUnitCost, '0.0400000000');
  assert.equal(db.onlyCallTo('update', 'receiptItems').set?.applicationStatus, 'applied');
  const applied = { ...line, applicationStatus: 'applied' };
  const retry = new FakeDb({ 'select:receiptItems': [[applied], [applied]], 'select:receipts': [[{ status: 'verified', currency: 'ILS' }]] });
  await assert.rejects(verifyReceipt({ db: retry as unknown as Database, shopId: 'shop', userId: 'user', receiptId: 'receipt', deferred: true,
    items: [{ id: 'line', accepted: true, packageQuantity: 250, packageUnit: 'g' }] }), /already been applied/);
  assert.equal(retry.callsTo('update', 'inventoryItems').length, 0);
});

test('global codes require a valid check digit; numeric retailer codes remain scoped', () => {
  assert.equal(productMeasurementKey('00123457'), 'barcode:00123457');
  assert.equal(productMeasurementKey('00123456'), null);
  assert.equal(productMeasurementKey('00123456', 'shufersal'), 'shufersal:00123456');
  const row = { chain: 'shufersal' as const, name: 'butter', price: 10, barcode: '00123457', score: 0 };
  assert.equal(selectExactProduct([row], '00123457')?.barcode, '00123457');
  assert.equal(selectExactProduct([row], '123457'), null);
  assert.equal(selectExactProduct([{ ...row, barcode: '12345678' }], '12345678'), null);
});

test('catalog downloads are cached and simultaneous exact requests share one download', async t => {
  let downloads = 0;
  const xml = '<Root><ChainId>7290055700007</ChainId><SubChainId>001</SubChainId><StoreId>134</StoreId><Item><ItemCode>00123457</ItemCode><ItemName>butter 250 g</ItemName><ItemPrice>10</ItemPrice><UnitQty>גרם</UnitQty><Quantity>250</Quantity><UnitOfMeasure>100 גרם</UnitOfMeasure><UnitOfMeasurePrice>4</UnitOfMeasurePrice><PriceUpdateDate>2026-10-13</PriceUpdateDate></Item></Root>';
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('.xml')) { downloads++; return new Response(xml); }
    return new Response('<a href="https://prices.shufersal.co.il/PriceFull20261013.xml">PriceFull</a>');
  });
  const [a, b] = await Promise.all([lookupExactProduct('00123457', 'shufersal'), lookupExactProduct('00123457', 'shufersal')]);
  assert.equal(downloads, 1);
  assert.deepEqual(a?.measurement?.measurement, { quantity: 250, unit: 'g' });
  assert.equal(a?.storeId, '134'); assert.equal(a?.sourceUpdatedAt, '2026-10-13'); assert.ok(a?.fetchedAt);
  assert.equal(b?.barcode, '00123457');
  await lookupExactProduct('00123457', 'shufersal');
  assert.equal(downloads, 1);
});

test('exact enrichment supplies contents but never substitutes the current catalog price', async () => {
  const line = { id: 'line', rawName: 'butter', rawSku: '00123457', quantity: '2', unit: 'pack', unitPrice: '10', totalPrice: '20' };
  const db = new FakeDb({ 'select:receiptItems': [[line], [line]], 'select:receipts': [[{ status: 'unverified', currency: 'ILS' }]],
    'select:productMeasurements': [[]], 'select:inventoryItems': [[], [{ id: 'inv', unit: 'g', measurementStatus: 'ready', currentQuantity: '0', averageUnitCost: null }]], 'insert:inventoryItems': [[{ id: 'inv' }]] });
  const result = await verifyReceipt({ db: db as unknown as Database, shopId: 'shop', userId: 'user', receiptId: 'receipt', items: [{ id: 'line', accepted: true }],
    lookup: async () => ({ chain: 'shufersal', name: 'butter', barcode: '00123457', price: 99, score: 0,
      measurement: { state: 'ready', reason: null, measurement: { quantity: 250, unit: 'g' }, provenance: ['catalog'] } }) });
  assert.equal(result.applied, 1);
  assert.equal(db.onlyCallTo('update', 'inventoryItems').set?.averageUnitCost, '0.0400000000');
  assert.equal(db.onlyCallTo('update', 'receiptItems').set?.totalPrice, '20');
});

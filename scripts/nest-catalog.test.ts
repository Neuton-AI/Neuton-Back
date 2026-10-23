import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import type { Database } from '../src/db/client.js';
import type { Category, InventoryItem } from '../src/db/schema/catalog.js';
import { FakeDb } from './support/fakeDb.js';
import { buildNestCatalogApp, SHOP_ID } from './support/nestCatalogApp.js';
import { buildCatalogApp } from './support/catalogApp.js';

const createdAt = new Date('2026-01-01T00:00:00Z');
const category = {
  id: '11111111-1111-1111-1111-111111111111', shopId: SHOP_ID,
  name: 'Flour', createdAt,
} satisfies Category;
const inventory = {
  id: '44444444-4444-4444-4444-444444444444', shopId: SHOP_ID,
  categoryId: category.id, name: 'Flour', rawMaterialName: 'flour', sku: null,
  imageUrl: null, unit: 'kg', baseUnit: 'g', baseUnitAmount: '1000.000',
  baseUnitCost: '0.002000', baseUnitAverageCost: '0.001500',
  currentQuantity: '2.000', reorderLevel: '2.000', lastUnitCost: '2.0000',
  averageUnitCost: '1.5000', isActive: true, createdAt, updatedAt: createdAt,
} satisfies InventoryItem;
const headers = { authorization: 'Bearer test', 'x-shop-id': SHOP_ID };

test('Nest catalog reads map explicit fields and preserve legacy decimal/date envelopes', async () => {
  const database = new FakeDb({
    'select:categories': [[{ ...category, privateColumn: 'do not expose' }], [category]],
    'select:inventoryItems': [
      [{ ...inventory, privateColumn: 'do not expose' }, { ...inventory, reorderLevel: null }],
      [inventory, { ...inventory, reorderLevel: null }],
    ],
  });
  const db = database as unknown as Database;
  const nest = await buildNestCatalogApp(db, 'member');
  const legacy = await buildCatalogApp('member');
  legacy.use({ db, deleteObject: async () => {} });
  try {
    for (const path of ['/categories', '/inventory']) {
      const next = await request(nest.app.getHttpServer()).get(`/api/v1${path}`).set(headers);
      const previous = await legacy.app.inject({ method: 'GET', url: `/api/v1${path}` });
      assert.equal(next.status, 200);
      assert.equal(previous.statusCode, 200);
      assert.deepEqual(next.body, previous.json());
      assert.equal(JSON.stringify(next.body).includes('privateColumn'), false);
      if (path === '/inventory') {
        assert.equal(next.body.items[0].baseUnitCost, '0.002000');
        assert.equal(next.body.items[0].createdAt, createdAt.toISOString());
        assert.equal(next.body.items[0].isLowStock, true, 'threshold equality counts as low');
        assert.equal(next.body.items[1].isLowStock, false, 'no threshold is not low stock');
      }
    }
  } finally {
    await nest.close();
    await legacy.close();
  }
});

test('Nest catalog rejects unauthenticated, foreign-shop and invalid queries before reads', async () => {
  const database = new FakeDb();
  const nest = await buildNestCatalogApp(database as unknown as Database);
  try {
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/categories')).status, 401);
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/inventory').set({
      ...headers, 'x-shop-id': '55555555-5555-5555-5555-555555555555',
    })).status, 403);
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/inventory').query({
      search: 'x'.repeat(121),
    }).set(headers)).status, 400);
    assert.deepEqual(database.calls, []);
  } finally {
    await nest.close();
  }
});

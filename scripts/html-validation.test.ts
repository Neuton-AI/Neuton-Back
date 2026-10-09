/**
 * Stored-XSS validation tests for #116.
 *
 * Every endpoint that persists free text must refuse values carrying HTML
 * characters *before* anything is written: `<` and `>` are the only characters
 * every tag needs, so a 400 on those keeps raw markup out of the database
 * without anyone having to parse HTML. The order payloads below are the
 * ticket's original reproduction steps verbatim, so the exact attack stays
 * covered; the rest walk the same guard across the shop, catalog and upload
 * schemas it was applied to.
 *
 * Each harness stubs the guards (they would reach Supabase) but registers the
 * real routes, and a rejected request must leave the scripted database
 * untouched — proof the check sits in front of the write, not after it.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildOrdersApp, SHOP_ID } from './support/ordersApp.js';
import { buildShopApp } from './support/shopApp.js';
import { buildCatalogApp } from './support/catalogApp.js';
import { buildReceiptsApp } from './support/receiptsApp.js';

const RECIPE_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '44444444-4444-4444-4444-444444444444';

type Harness = {
  app: { inject: Function; close: () => Promise<void> };
  db: FakeDb;
  close(): Promise<void>;
};

async function post(h: Harness, url: string, payload: Record<string, unknown>) {
  const response = await h.app.inject({ method: 'POST', url, payload });
  return { status: response.statusCode, body: response.json() as any };
}

/** The field names a 400 pointed at, sorted so the assertion is order-free. */
function flaggedPaths(body: any): string[] {
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  return body.error.details.map((issue: any) => String(issue.path[0])).sort();
}

async function ordersHarness(responses: Record<string, unknown[]> = {}): Promise<Harness> {
  const db = new FakeDb(responses);
  const testApp = await buildOrdersApp();
  testApp.use({ db: db as never });
  return { app: testApp.app, db, close: testApp.close };
}

async function catalogHarness(): Promise<Harness> {
  const db = new FakeDb({});
  const testApp = await buildCatalogApp();
  testApp.use({ db: db as never, deleteObject: async () => {} });
  return { app: testApp.app, db, close: testApp.close };
}

async function receiptsHarness(): Promise<Harness> {
  const db = new FakeDb({});
  const testApp = await buildReceiptsApp();
  testApp.use({ db: db as never, deleteObject: async () => {} });
  return { app: testApp.app, db, close: testApp.close };
}

test('POST /orders refuses the ticket payloads with 400 and writes nothing', async () => {
  const h = await ordersHarness();
  try {
    const { status, body } = await post(h, '/api/v1/orders', {
      customerName: '<script>alert(1)</script><img src=x onerror=alert(2)>',
      destinationAddress: '<svg onload=alert(3)>',
      orderDate: '2026-10-08T09:00:00.000Z',
      deliveryDistanceKm: 0,
      items: [{ recipeId: RECIPE_ID, quantity: 1 }],
    });

    assert.equal(status, 400);
    assert.deepEqual(flaggedPaths(body), ['customerName', 'destinationAddress']);
    assert.deepEqual(h.db.calls, [], 'a rejected order must not touch the database');
  } finally {
    await h.close();
  }
});

test('POST /orders stores plain text verbatim — the guard rejects, it never rewrites', async () => {
  const customerName = `Dana O'Brien & Sons "Catering"`;
  const destinationAddress = '12 HaYarkon St, Apt #4 — 100% on time';
  const h = await ordersHarness({
    'select:recipes': [
      [{ id: RECIPE_ID, name: 'Focaccia', prepTimeMinutes: 30, yieldQuantity: '4', targetMarginPct: null }],
    ],
    'select:recipeIngredients': [[{ recipeId: RECIPE_ID, quantity: '1.000', averageUnitCost: '2.00' }]],
    'update:shops': [[{ lastOrderNumber: 1 }]],
    'insert:orders': [[{ id: ORDER_ID, shopId: SHOP_ID, status: 'processing', orderNumber: 1 }]],
    'insert:orderItems': [[]],
  });
  try {
    const { status } = await post(h, '/api/v1/orders', {
      customerName,
      destinationAddress,
      deliveryDistanceKm: 0,
      items: [{ recipeId: RECIPE_ID, quantity: 1 }],
    });

    assert.equal(status, 201, 'apostrophes, quotes and ampersands are text, not markup');
    const insert = h.db.onlyCallTo('insert', 'orders');
    assert.equal((insert.values as any).customerName, customerName);
    assert.equal((insert.values as any).destinationAddress, destinationAddress);
  } finally {
    await h.close();
  }
});

test('PATCH /shop refuses HTML in storeAddress, name and timezone', async () => {
  const testApp = await buildShopApp();
  try {
    const response = await testApp.app.inject({
      method: 'PATCH',
      url: '/api/v1/shop',
      payload: {
        name: '<img src=x onerror=alert(2)>',
        storeAddress: '<svg onload=alert(3)>',
        timezone: '<script>alert(1)</script>',
      },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(flaggedPaths(response.json() as any), ['name', 'storeAddress', 'timezone']);
  } finally {
    await testApp.close();
  }
});

test('POST /shops refuses HTML in the shop address', async () => {
  const testApp = await buildShopApp();
  try {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/shops',
      payload: { name: 'Test Shop', storeAddress: '<svg onload=alert(3)>' },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(flaggedPaths(response.json() as any), ['storeAddress']);
  } finally {
    await testApp.close();
  }
});

test('POST /recipes refuses HTML wherever the recipe text lives', async () => {
  const clean = {
    name: 'Focaccia',
    ingredients: [{ rawName: 'Flour', quantity: 1, unit: 'kg' }],
  };
  // Short enough for every field's own length cap, so the only issue raised
  // is the HTML one and the assertion stays exact.
  const payload = '<svg onload=alert(3)>';

  for (const field of ['name', 'description', 'instructions', 'yieldUnit'] as const) {
    const h = await catalogHarness();
    try {
      const { status, body } = await post(h, '/api/v1/recipes', {
        ...clean,
        [field]: payload,
      });

      assert.equal(status, 400, `${field} must be rejected`);
      assert.deepEqual(flaggedPaths(body), [field]);
      assert.deepEqual(h.db.calls, [], `${field}: nothing reaches the database`);
    } finally {
      await h.close();
    }
  }

  const h = await catalogHarness();
  try {
    const { status, body } = await post(h, '/api/v1/recipes', {
      ...clean,
      ingredients: [{ rawName: '<b>Flour</b>', quantity: 1, unit: 'kg' }],
    });
    assert.equal(status, 400, 'ingredient text is covered too');
    assert.deepEqual(flaggedPaths(body), ['ingredients']);
  } finally {
    await h.close();
  }
});

test('POST /uploads/presign refuses an HTML originalFilename', async () => {
  const h = await receiptsHarness();
  try {
    const { status, body } = await post(h, '/api/v1/uploads/presign', {
      kind: 'receipt',
      contentType: 'image/jpeg',
      originalFilename: '<img src=x onerror=alert(2)>.jpg',
    });

    assert.equal(status, 400);
    assert.deepEqual(flaggedPaths(body), ['originalFilename']);
    assert.deepEqual(h.db.calls, [], 'nothing reaches the database');
  } finally {
    await h.close();
  }
});

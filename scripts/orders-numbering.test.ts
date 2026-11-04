import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { asc, eq } from 'drizzle-orm';
import { inventoryItems, orders, recipeIngredients, recipes } from '../src/db/schema/index.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { buildSyncApplication } from './support/syncApp.js';

async function orderFixture() {
  const fixture = await neonFixture();
  try {
    const recipeId = await fixture.inShop(async ({ database, shopId }) => {
      const [flour] = await database.insert(inventoryItems).values({ shopId, name: 'Flour',
        rawMaterialName: 'Flour', unit: 'kg', averageUnitCost: '2.00', baseUnit: 'g',
        baseUnitAmount: '1000.000', baseUnitCost: '0.002000', baseUnitAverageCost: '0.002000' }).returning();
      assert.ok(flour);
      const [recipe] = await database.insert(recipes).values({ shopId, name: 'Focaccia' }).returning();
      assert.ok(recipe);
      await database.insert(recipeIngredients).values({ shopId, recipeId: recipe.id,
        inventoryItemId: flour.id, rawName: 'Flour', rawMaterialName: 'Flour', quantity: '1.000',
        rawSrcUnit: 'kg', baseUnit: 'g', baseUnitAmount: '1000.000' });
      return recipe.id;
    });
    const app = await buildSyncApplication(fixture.application, fixture.shop, fixture.userId, 'owner',
      { id: fixture.sessionId, secret: fixture.secret });
    const headers = { cookie: `neuton-dev-session=${fixture.secret}`, 'x-shop-id': fixture.shopId };
    return { ...fixture, app, headers, recipeId,
      async close() { try { await app.close(); } finally { await fixture.close(); } } };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

test('parallel creates come out as one gapless per-shop sequence', { skip: neonTestSkip }, async () => {
  const f = await orderFixture();
  try {
    const parallel = 10;
    const responses = await Promise.all(Array.from({ length: parallel }, (_, index) =>
      f.app.inject({ method: 'POST', url: '/api/v1/orders', headers: f.headers,
        payload: { customerName: `Order ${index}`, deliveryDistanceKm: 0,
          items: [{ recipeId: f.recipeId, quantity: 1 }] } })));
    assert.deepEqual(responses.filter(response => response.statusCode !== 201)
      .map(response => ({ status: response.statusCode, body: response.json() })), [],
      'every concurrent create must succeed');
    const rows = await f.inShop(({ database }) => database.select({ orderNumber: orders.orderNumber })
      .from(orders).where(eq(orders.shopId, f.shopId)).orderBy(asc(orders.orderNumber)));
    assert.deepEqual(rows.map(row => row.orderNumber), Array.from({ length: parallel }, (_, index) => index + 1),
      'ten racing creates issue 1..10 exactly once, with no gaps');
  } finally {
    await f.close();
  }
});

test('a cancelled order keeps its number and it is never handed out again', { skip: neonTestSkip }, async () => {
  const f = await orderFixture();
  const create = () => f.app.inject({ method: 'POST', url: '/api/v1/orders', headers: f.headers,
    payload: { customerName: 'Voided sale', deliveryDistanceKm: 0,
      items: [{ recipeId: f.recipeId, quantity: 1 }] } });
  try {
    const first = await create();
    assert.equal(first.statusCode, 201, first.body);
    const issued = first.json().order as { id: string; orderNumber: number };
    assert.equal(issued.orderNumber, 1);
    const cancelled = await f.app.inject({ method: 'DELETE', url: `/api/v1/orders/${issued.id}`, headers: f.headers });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const [voided] = await f.inShop(({ database }) => database.select().from(orders).where(eq(orders.id, issued.id)));
    assert.ok(voided, 'cancelled row must survive');
    assert.equal(voided.status, 'cancelled');
    assert.equal(voided.orderNumber, 1);
    const next = await create();
    assert.equal(next.statusCode, 201, next.body);
    assert.equal(next.json().order.orderNumber, 2, 'cancelled numbers are never reused');
    const read = await f.app.inject({ method: 'GET', url: `/api/v1/orders/${issued.id}`, headers: f.headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().order.status, 'cancelled');
    assert.equal(read.json().order.orderNumber, 1);
  } finally {
    await f.close();
  }
});

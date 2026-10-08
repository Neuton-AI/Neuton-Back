/**
 * Sequential per-shop order numbers against a live Postgres (N-105).
 *
 * `scripts/orders.test.ts` pins the statements the routes send; this file pins
 * what only a real database can prove — that parallel creates come out as one
 * gapless sequence, and that cancelling an order keeps its number out of
 * circulation instead of freeing it. Each case seeds its own shop and drops it
 * afterwards, so running it against a developer database leaves nothing behind.
 *
 * Like `signed-download.test.ts`, both cases skip themselves when the suite
 * placeholder filled in `DATABASE_URL` (CI, a fresh clone) instead of hanging
 * on a refused connection.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { asc, eq, sql } from 'drizzle-orm';
import { isPlaceholder } from './support/testEnv.js';
import { db } from '../src/db/client.js';
import {
  inventoryItems,
  orders,
  profiles,
  recipeIngredients,
  recipes,
  shops,
} from '../src/db/schema/index.js';
import { buildOrdersApp, SHOP_ID, USER_ID } from './support/ordersApp.js';

const databaseBacked = !isPlaceholder('DATABASE_URL');
const skip = databaseBacked
  ? false
  : 'no real DATABASE_URL configured (CI) — order-numbering cases skipped';

/**
 * A shop with one orderable recipe, starting from an empty sequence.
 *
 * The assertions below are absolute (`1`, `2`, `3` …), so a shop left behind by
 * an interrupted run is dropped rather than resumed: what is being proved is
 * the sequence from scratch, not the backfill.
 */
async function seedShop(): Promise<string> {
  await db.delete(shops).where(eq(shops.id, SHOP_ID));
  await db.delete(profiles).where(eq(profiles.id, USER_ID));
  await db.execute(sql`delete from auth.users where id = ${USER_ID}`);

  await db.execute(sql`insert into auth.users (id, email) values (${USER_ID}, 'n105@example.com') on conflict do nothing`);
  await db.insert(profiles).values({ id: USER_ID });
  await db.insert(shops).values({
    id: SHOP_ID,
    name: 'N105 sequence shop',
    slug: `n105-sequence-${Date.now()}`,
  });

  const [flour] = await db
    .insert(inventoryItems)
    .values({ shopId: SHOP_ID, name: 'Flour', unit: 'kg', averageUnitCost: '2.00' })
    .returning();
  if (!flour) throw new Error('fixture: inventory insert returned no row');

  const [recipe] = await db
    .insert(recipes)
    .values({ shopId: SHOP_ID, name: 'Focaccia' })
    .returning();
  if (!recipe) throw new Error('fixture: recipe insert returned no row');

  await db.insert(recipeIngredients).values({
    shopId: SHOP_ID,
    recipeId: recipe.id,
    inventoryItemId: flour.id,
    rawName: 'Flour',
    quantity: '1.000',
    unit: 'kg',
  });

  return recipe.id;
}

/** The shop goes first so its orders, lines, recipes and stock cascade with it. */
async function dropShop(): Promise<void> {
  await db.delete(shops).where(eq(shops.id, SHOP_ID));
  await db.delete(profiles).where(eq(profiles.id, USER_ID));
  await db.execute(sql`delete from auth.users where id = ${USER_ID}`);
}

test('parallel creates come out as one gapless per-shop sequence', { skip }, async () => {
  const recipeId = await seedShop();
  const testApp = await buildOrdersApp('owner');
  testApp.use({ db: db as never });

  try {
    const PARALLEL = 10;
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        testApp.app.inject({
          method: 'POST',
          url: '/api/v1/orders',
          payload: {
            customerName: `Order ${index}`,
            deliveryDistanceKm: 0,
            items: [{ recipeId, quantity: 1 }],
          },
        }),
      ),
    );

    assert.deepEqual(
      responses
        .filter((response) => response.statusCode !== 201)
        .map((response) => ({ status: response.statusCode, body: response.json() })),
      [],
      'every concurrent create has to succeed for the sequence to mean anything',
    );

    const rows = await db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.shopId, SHOP_ID))
      .orderBy(asc(orders.orderNumber));

    assert.deepEqual(
      rows.map((row) => row.orderNumber),
      Array.from({ length: PARALLEL }, (_, index) => index + 1),
      'ten racing creates issued 1..10 exactly once each: no duplicate, no gap, no skip',
    );
  } finally {
    await testApp.close();
    await dropShop();
  }
});

test('a cancelled order keeps its number and it is never handed out again', { skip }, async () => {
  const recipeId = await seedShop();
  const testApp = await buildOrdersApp('owner');
  testApp.use({ db: db as never });

  const create = () =>
    testApp.app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      payload: {
        customerName: 'Voided sale',
        deliveryDistanceKm: 0,
        items: [{ recipeId, quantity: 1 }],
      },
    });

  try {
    const first = await create();
    assert.equal(first.statusCode, 201);
    const issued = first.json().order as { id: string; orderNumber: number };
    assert.equal(issued.orderNumber, 1);

    const cancelled = await testApp.app.inject({
      method: 'DELETE',
      url: `/api/v1/orders/${issued.id}`,
    });
    assert.equal(cancelled.statusCode, 200);

    const [voided] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, issued.id));
    assert.ok(voided, 'the row must survive the cancel');
    assert.equal(voided.status, 'cancelled');
    assert.equal(voided.orderNumber, 1, 'the void keeps the number it was issued');

    const next = await create();
    assert.equal(next.statusCode, 201);
    assert.equal(
      (next.json().order as { orderNumber: number }).orderNumber,
      2,
      'a cancelled number is out of circulation, not back in the pool',
    );

    const read = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/orders/${issued.id}`,
    });
    assert.equal(read.statusCode, 200);
    const shown = read.json().order as { status: string; orderNumber: number };
    assert.equal(shown.status, 'cancelled');
    assert.equal(shown.orderNumber, 1, 'the void stays readable, number and all');
  } finally {
    await testApp.close();
    await dropShop();
  }
});

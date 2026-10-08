/**
 * Order status lifecycle tests for N-103.
 *
 * These drive the real `orderRoutes` over a Fastify instance whose three auth
 * guards are stubbed (`scripts/support/ordersApp.ts`). The route bodies are the
 * production ones; only the collaborators are replaced — `request.ordersDeps`
 * swaps in a `FakeDb`, so no query or network call is live.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb } from './support/fakeDb.js';
import { buildOrdersApp, SHOP_ID } from './support/ordersApp.js';

const RECIPE_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '44444444-4444-4444-4444-444444444444';

const recipeRow = {
  id: RECIPE_ID,
  name: 'Focaccia',
  prepTimeMinutes: 30,
  yieldQuantity: '4',
  targetMarginPct: null,
};

function recipeResponses() {
  return {
    'select:recipes': [[recipeRow]],
    'select:recipeIngredients': [[{ recipeId: RECIPE_ID, quantity: '1.000', averageUnitCost: '2.00' }]],
  };
}

async function harness(role = 'owner', responses: Record<string, unknown[]> = {}) {
  const db = new FakeDb(responses);
  const testApp = await buildOrdersApp(role);
  testApp.use({ db: db as never });
  return {
    db,
    async post(url: string, body: Record<string, unknown>) {
      const response = await testApp.app.inject({ method: 'POST', url, payload: body });
      return { status: response.statusCode, body: response.json() as any };
    },
    async get(url: string) {
      const response = await testApp.app.inject({ method: 'GET', url });
      return { status: response.statusCode, body: response.json() as any };
    },
    async patch(url: string, body: Record<string, unknown>) {
      const response = await testApp.app.inject({ method: 'PATCH', url, payload: body });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => testApp.close(),
  };
}

test('POST /orders always creates processing orders, even when the client sends a status', async () => {
  const h = await harness('owner', {
    ...recipeResponses(),
    'insert:orders': [[{ id: ORDER_ID, shopId: SHOP_ID, status: 'processing' }]],
    'insert:orderItems': [[]],
  });
  try {
    const { status, body } = await h.post('/api/v1/orders', {
      customerName: 'Dana',
      deliveryDistanceKm: 0,
      // A stray / forged field must never promote the order to delivered.
      status: 'delivered',
      items: [{ recipeId: RECIPE_ID, quantity: 2 }],
    });
    assert.equal(status, 201);
    assert.equal(body.order.status, 'processing');

    const insert = h.db.onlyCallTo('insert', 'orders');
    assert.equal((insert.values as any).status, 'processing');
  } finally {
    await h.close();
  }
});

test('GET /orders returns status and supports ?status filter', async () => {
  const h = await harness('owner', {
    'select:orders': [
      [{ id: ORDER_ID, status: 'processing', totalAmount: '10.00', deliveryFee: '0', totalCost: '4.00' }],
      [{ count: 1 }],
    ],
  });
  try {
    const { status, body } = await h.get('/api/v1/orders?status=processing');
    assert.equal(status, 200);
    assert.equal(body.orders[0].status, 'processing');
    assert.equal(body.total, 1);
  } finally {
    await h.close();
  }
});

test('GET /orders rejects an unknown status with 400', async () => {
  const h = await harness();
  try {
    const { status, body } = await h.get('/api/v1/orders?status=shipped');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(h.db.calls, [], 'a rejected request must not touch the database');
  } finally {
    await h.close();
  }
});

test('PATCH /orders/:id/status moves processing -> delivered for any shop member', async () => {
  for (const role of ['owner', 'admin', 'member']) {
    const h = await harness(role, {
      'select:orders': [[{ id: ORDER_ID, shopId: SHOP_ID, status: 'processing', deletedAt: null }]],
      'update:orders': [[{ id: ORDER_ID, shopId: SHOP_ID, status: 'delivered' }]],
    });
    try {
      const { status, body } = await h.patch(`/api/v1/orders/${ORDER_ID}/status`, {
        status: 'delivered',
      });
      assert.equal(status, 200, `role=${role} should be allowed`);
      assert.equal(body.order.status, 'delivered');
      const update = h.db.onlyCallTo('update', 'orders');
      assert.deepEqual(update.set, { status: 'delivered' });
    } finally {
      await h.close();
    }
  }
});

test('PATCH /orders/:id/status rejects an already-delivered order with 400', async () => {
  const h = await harness('member', {
    'select:orders': [[{ id: ORDER_ID, shopId: SHOP_ID, status: 'delivered', deletedAt: null }]],
  });
  try {
    const { status, body } = await h.patch(`/api/v1/orders/${ORDER_ID}/status`, {
      status: 'delivered',
    });
    assert.equal(status, 400);
    assert.match(body.error.message, /already delivered/);
    assert.deepEqual(
      h.db.callsTo('update', 'orders'),
      [],
      'a blocked transition must not write',
    );
  } finally {
    await h.close();
  }
});

test('PATCH /orders/:id/status rejects invalid values with 400', async () => {
  const h = await harness('owner');
  try {
    const { status, body } = await h.patch(`/api/v1/orders/${ORDER_ID}/status`, {
      status: 'processing',
    });
    assert.equal(status, 400);
    assert.ok(body.error, 'an error envelope is returned');
    const { status: badStatus, body: badBody } = await h.patch(
      `/api/v1/orders/${ORDER_ID}/status`,
      { status: 'shipped' },
    );
    assert.equal(badStatus, 400);
    assert.equal(badBody.error.code, 'VALIDATION_ERROR');
  } finally {
    await h.close();
  }
});

test('PATCH /orders/:id/status reads cross-shop access as 404', async () => {
  const h = await harness('owner', { 'select:orders': [[]] });
  try {
    const { status, body } = await h.patch(`/api/v1/orders/${ORDER_ID}/status`, {
      status: 'delivered',
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('GET /orders/:id returns status', async () => {
  const h = await harness('owner', {
    'select:orders': [
      [
        {
          id: ORDER_ID,
          shopId: SHOP_ID,
          status: 'delivered',
          totalAmount: '10.00',
          deliveryFee: '0',
          totalCost: '4.00',
        },
      ],
    ],
    'select:orderItems': [[[]]],
  });
  try {
    // The items join reads from `orderItems` first, so the queued rows above
    // land on the order lookup; push the empty items page explicitly.
    const { status, body } = await h.get(`/api/v1/orders/${ORDER_ID}`);
    assert.equal(status, 200);
    assert.equal(body.order.status, 'delivered');
  } finally {
    await h.close();
  }
});

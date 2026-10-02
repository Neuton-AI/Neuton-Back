/**
 * Analytics aggregation tests for N-21a.
 *
 * These drive the real `analyticsRoutes` over a Fastify instance whose two auth
 * guards are stubbed (`scripts/support/testApp.ts`). The route bodies are the
 * production ones; only the collaborators are replaced — `request.analyticsDeps`
 * swaps in a `FakeDb` and a pinned clock, so no query, clock read, or network
 * call is live.
 *
 * The database answers from a per-table FIFO of scripted rows. A dashboard read
 * issues several statements against the same table, so the queue order encodes
 * the query order; `pins the dashboard query count` asserts that order so a
 * change in query shape fails loudly instead of silently re-labelling fixtures.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeDb, type FakeResponses } from './support/fakeDb.js';
import { buildAnalyticsApp, NOW, SHOP_ID } from './support/testApp.js';
import {
  PERIOD_DAYS,
  netProfitOf,
  periodStart,
  previousPeriodStart,
  trendPercent,
} from '../src/routes/analytics.js';

async function harness(responses: FakeResponses = {}) {
  const db = new FakeDb(responses);
  const testApp = await buildAnalyticsApp();
  testApp.use({ db: db as never, now: () => NOW });

  return {
    db,
    async get(url: string) {
      const response = await testApp.app.inject({ method: 'GET', url });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => testApp.close(),
  };
}

/* ------------------------------------------------------------------ helpers */

test('periodStart opens an inclusive window of exactly PERIOD_DAYS days', () => {
  const today = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate());
  for (const period of Object.keys(PERIOD_DAYS) as Array<keyof typeof PERIOD_DAYS>) {
    const days = (today - periodStart(period, NOW).getTime()) / 86_400_000 + 1;
    assert.equal(days, PERIOD_DAYS[period], `${period} spanned ${days} days`);
  }
});

test('periodStart snaps to UTC midnight and walks whole days across a DST-style shift', () => {
  const start = periodStart('7d', new Date('2026-03-08T23:59:59.999Z'));
  assert.equal(start.toISOString(), '2026-03-02T00:00:00.000Z');
});

test('the comparison window sits immediately before the current one', () => {
  assert.equal(periodStart('7d', NOW).toISOString(), '2026-06-09T00:00:00.000Z');
  assert.equal(previousPeriodStart('7d', NOW).toISOString(), '2026-06-02T00:00:00.000Z');
  assert.equal(periodStart('12m', NOW).toISOString(), '2025-06-16T00:00:00.000Z');
});

test('trendPercent reports direction and never divides by zero', () => {
  assert.equal(trendPercent(150, 100), 50);
  assert.equal(trendPercent(50, 100), -50);
  assert.equal(trendPercent(0, 100), -100);
  assert.equal(trendPercent(40, 0), 100, 'a zero baseline reads as 100%, not Infinity');
  assert.equal(trendPercent(0, 0), 0);
  assert.equal(trendPercent(50, -100), 150, 'a negative baseline uses its magnitude');
});

test('netProfitOf deducts delivery, production cost and recorded expenses', () => {
  assert.equal(netProfitOf(300, 20, 120, 45), 115);
  assert.equal(netProfitOf(100, 0, 0, 0), 100);
  assert.equal(netProfitOf(0, 5, 10, 1), -16, 'a loss stays negative');
});

/* ---------------------------------------------------------------- dashboard */

test('dashboard: totals, trends, graph, top item, order stats and low stock', async () => {
  const h = await harness({
    'select:orders': [
      // current window
      [{ revenue: '300.00', cost: '120.00', delivery: '20.00', count: 3 }],
      // comparison window
      [{ revenue: '200.00', delivery: '10.00', cost: '90.00' }],
      // per-order profit sample
      [{ netProfit: '40.00' }, { netProfit: '60.00' }, { netProfit: '50.00' }],
      // daily graph series
      [
        { day: '2026-06-10', revenue: '150.00', delivery: '10.00', cost: '60.00' },
        { day: '2026-06-14', revenue: '150.00', delivery: '10.00', cost: '60.00' },
      ],
    ],
    'select:receipts': [
      [{ expenses: '45.00' }],
      [{ expenses: '30.00' }],
      [{ day: '2026-06-10', total: '25.00' }, { day: '2026-06-12', total: '20.00' }],
    ],
    'select:orderItems': [
      [
        {
          recipeId: 'rec-1',
          name: 'Focaccia',
          imageUrl: null,
          unitsSold: '6.000',
          revenue: '144.00',
          cost: '72.00',
        },
      ],
    ],
    'select:inventoryItems': [
      [{ id: 'inv-1', name: 'Flour', unit: 'kg', currentQuantity: '2.000', reorderLevel: '5.000' }],
    ],
  });

  try {
    const { status, body } = await h.get('/api/v1/analytics/dashboard');
    assert.equal(status, 200);

    assert.equal(body.period, '30d', 'a missing period defaults to 30d');
    assert.deepEqual(body.range, {
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-06-15T12:34:56.000Z',
    });

    assert.deepEqual(body.summary, {
      revenue: 300,
      expenses: 45,
      deliveryFees: 20,
      productionCost: 120,
      netProfit: 115,
      orderCount: 3,
      profitMarginPercent: 38.3,
    });

    assert.deepEqual(body.trend, { revenuePercent: 50, profitPercent: 64.3, expensesPercent: 50 });

    assert.deepEqual(body.graph, [
      { date: '2026-06-10', revenue: 150, expenses: 25, netProfit: 55 },
      // 2026-06-12 has an expense row but no sales, so it never reaches the graph.
      { date: '2026-06-14', revenue: 150, expenses: 0, netProfit: 80 },
    ]);

    assert.deepEqual(body.topItem, {
      recipeId: 'rec-1',
      name: 'Focaccia',
      imageUrl: null,
      unitsSold: 6,
      revenue: 144,
      netProfit: 72,
    });

    assert.deepEqual(body.orderProfitability, { average: 50, median: 50, sampleSize: 3 });

    assert.deepEqual(body.lowStock, [
      { id: 'inv-1', name: 'Flour', unit: 'kg', currentQuantity: 2, reorderLevel: 5 },
    ]);
  } finally {
    await h.close();
  }
});

test('dashboard: a shop with no activity reports zeroes, not nulls', async () => {
  const h = await harness();

  try {
    const { status, body } = await h.get('/api/v1/analytics/dashboard');

    assert.equal(status, 200);
    assert.deepEqual(body.summary, {
      revenue: 0,
      expenses: 0,
      deliveryFees: 0,
      productionCost: 0,
      netProfit: 0,
      orderCount: 0,
      profitMarginPercent: 0,
    });
    assert.deepEqual(body.trend, { revenuePercent: 0, profitPercent: 0, expensesPercent: 0 });
    assert.deepEqual(body.graph, []);
    assert.deepEqual(body.orderProfitability, { average: 0, median: 0, sampleSize: 0 });
    assert.equal(body.topItem, null, 'no sales means no top item, not a crash');
    assert.deepEqual(body.lowStock, []);
  } finally {
    await h.close();
  }
});

test('dashboard: a loss reports a negative margin instead of clamping at zero', async () => {
  const h = await harness({
    'select:orders': [[{ revenue: '100.00', cost: '200.00', delivery: '10.00', count: 2 }]],
    'select:receipts': [[{ expenses: '15.00' }]],
  });

  try {
    const { body } = await h.get('/api/v1/analytics/dashboard');
    assert.equal(body.summary.netProfit, -125);
    assert.equal(body.summary.profitMarginPercent, -125);
    assert.equal(body.trend.profitPercent, 100, 'a zero baseline reports 100 whatever the sign');
  } finally {
    await h.close();
  }
});

test('dashboard: order stats summarise an even and an odd sample', async () => {
  const even = await harness({
    'select:orders': [
      [{ revenue: '0', cost: '0', delivery: '0', count: 2 }],
      [{ revenue: '0', delivery: '0', cost: '0' }],
      [{ netProfit: '10.00' }, { netProfit: '31.00' }],
    ],
  });
  const odd = await harness({
    'select:orders': [
      [{ revenue: '0', cost: '0', delivery: '0', count: 3 }],
      [{ revenue: '0', delivery: '0', cost: '0' }],
      [{ netProfit: '10.00' }, { netProfit: '20.00' }, { netProfit: '30.00' }],
    ],
  });

  try {
    assert.deepEqual((await even.get('/api/v1/analytics/dashboard')).body.orderProfitability, {
      average: 20.5,
      median: 20.5,
      sampleSize: 2,
    });
    assert.deepEqual((await odd.get('/api/v1/analytics/dashboard')).body.orderProfitability, {
      average: 20,
      median: 20,
      sampleSize: 3,
    });
  } finally {
    await even.close();
    await odd.close();
  }
});

test('dashboard: pins the dashboard query count', async () => {
  const h = await harness();

  try {
    await h.get('/api/v1/analytics/dashboard');
    assert.deepEqual(h.db.callSequence(), [
      'select:orders',
      'select:receipts',
      'select:orders',
      'select:receipts',
      'select:orderItems',
      'select:orders',
      'select:inventoryItems',
      'select:orders',
      'select:receipts',
    ]);
  } finally {
    await h.close();
  }
});

test('dashboard: a rejected window is a 400 envelope and runs no query', async () => {
  const h = await harness();

  try {
    for (const period of ['1y', '7', '', '7D', '30d;drop']) {
      const { status, body } = await h.get(`/api/v1/analytics/dashboard?period=${encodeURIComponent(period)}`);
      assert.equal(status, 400, `period=${period} should be rejected: ${JSON.stringify(body)}`);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
    assert.deepEqual(h.db.calls, [], 'a rejected request must not touch the database');
  } finally {
    await h.close();
  }
});

test('dashboard: every supported window is accepted', async () => {
  for (const period of ['7d', '30d', '90d', '12m'] as const) {
    const h = await harness();
    try {
      const { status, body } = await h.get(`/api/v1/analytics/dashboard?period=${period}`);
      assert.equal(status, 200);
      assert.equal(body.period, period);
    } finally {
      await h.close();
    }
  }
});

/* ----------------------------------------------------------- recent orders */

test('recent-orders: each row carries its own net profit', async () => {
  const h = await harness({
    'select:orders': [
      [
        { id: 'order-1', totalAmount: '120.00', deliveryFee: '10.00', totalCost: '50.00' },
        { id: 'order-2', totalAmount: '40.00', deliveryFee: '5.00', totalCost: '60.00' },
      ],
    ],
  });

  try {
    const { status, body } = await h.get('/api/v1/analytics/recent-orders');

    assert.equal(status, 200);
    assert.deepEqual(
      body.orders.map((order: any) => ({ id: order.id, netProfit: order.netProfit })),
      [
        { id: 'order-1', netProfit: 60 },
        { id: 'order-2', netProfit: -25 },
      ],
    );
    assert.equal(body.orders[0].totalAmount, '120.00', 'the stored columns are passed through');
    assert.equal(h.db.onlyCallTo('select', 'orders').limit, 5, 'the default limit is 5');
  } finally {
    await h.close();
  }
});

test('recent-orders: the limit is coerced, bounded and validated', async () => {
  const h = await harness();

  try {
    await h.get('/api/v1/analytics/recent-orders?limit=3');
    assert.equal(h.db.onlyCallTo('select', 'orders').limit, 3);

    const tooMany = await h.get('/api/v1/analytics/recent-orders?limit=21');
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'VALIDATION_ERROR');

    const tooFew = await h.get('/api/v1/analytics/recent-orders?limit=0');
    assert.equal(tooFew.status, 400);

    const notANumber = await h.get('/api/v1/analytics/recent-orders?limit=lots');
    assert.equal(notANumber.status, 400);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------- inventory value */

test('inventory-value: reports the stock value and how many items back it', async () => {
  const h = await harness({
    'select:inventoryItems': [[{ value: '1234.50', units: 12 }]],
  });

  try {
    const { status, body } = await h.get('/api/v1/analytics/inventory-value');
    assert.equal(status, 200);
    assert.deepEqual(body, { inventoryValue: 1234.5, trackedItems: 12 });
  } finally {
    await h.close();
  }
});

test('inventory-value: an empty catalog reports zero, not undefined', async () => {
  const h = await harness();

  try {
    const { body } = await h.get('/api/v1/analytics/inventory-value');
    assert.deepEqual(body, { inventoryValue: 0, trackedItems: 0 });
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------- guards */

test('analytics reads the shop from the resolved context', async () => {
  const h = await harness();

  try {
    assert.equal(SHOP_ID.length, 36);
    await h.get('/api/v1/analytics/dashboard');
    assert.equal(h.db.callsTo('select', 'orders').length, 4);
  } finally {
    await h.close();
  }
});

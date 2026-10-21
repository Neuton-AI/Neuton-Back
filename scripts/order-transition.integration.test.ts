import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { orders } from '../src/db/schema/index.js';
import * as schema from '../src/db/schema/index.js';
import type { Database } from '../src/db/client.js';
import { buildOrdersApp, SHOP_ID } from './support/ordersApp.js';

const databaseUrl = process.env.ORDER_TRANSITION_TEST_DATABASE_URL;
const ORDER_ID = '44444444-4444-4444-4444-444444444444';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Pause verification after its real SELECT completes. The competing operation
// then commits before verification issues its UPDATE, deterministically exposing
// a stale-read race without sleeps or a query-result fake.
function pauseAfterSelect(target: object, selected: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>): object {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      if (key === 'then') {
        return (resolve: (rows: unknown) => void, reject: (error: unknown) => void) => {
          Promise.resolve(object).then(async (rows) => {
            selected.resolve();
            await resume.promise;
            return rows;
          }).then(resolve, reject);
        };
      }
      return typeof value === 'function'
        ? (...args: unknown[]) => pauseAfterSelect(value.apply(object, args), selected, resume)
        : value;
    },
  });
}

test('order verification cannot overwrite a concurrent cancellation, verification or soft deletion', {
  skip: !databaseUrl && 'requires ORDER_TRANSITION_TEST_DATABASE_URL pointing at disposable PostgreSQL',
}, async () => {
  const connection = postgres(databaseUrl!, { max: 1 });
  const database = drizzle(connection, { schema });
  const app = await buildOrdersApp('owner');
  try {
    // These temporary tables are connection-local and never touch real tables.
    await connection.unsafe(`CREATE TEMP TABLE orders (
      id uuid PRIMARY KEY, order_number integer NOT NULL, shop_id uuid NOT NULL,
      user_id uuid, customer_name text, order_date timestamptz DEFAULT now(),
      destination_address text, delivery_distance_km numeric DEFAULT 0,
      delivery_fee numeric DEFAULT 0, applied_profit_margin numeric,
      total_cost numeric DEFAULT 0, total_amount numeric DEFAULT 0,
      document_url text, status text DEFAULT 'processing',
      created_at timestamptz DEFAULT now(), deleted_at timestamptz
    )`);
    for (const competitor of ['cancelled', 'delivered', 'deleted'] as const) {
      await connection`DELETE FROM orders`;
      await connection`INSERT INTO orders(id,order_number,shop_id) VALUES (${ORDER_ID},1,${SHOP_ID})`;
      const selected = deferred();
      const resume = deferred();
      app.use({ db: {
        select: (...args: Parameters<typeof database.select>) =>
          pauseAfterSelect(database.select(...args), selected, resume),
        update: database.update.bind(database),
      } as unknown as Database });

      const verifying = app.app.inject({ method: 'POST', url: `/api/v1/orders/${ORDER_ID}/verify` });
      // Injection is lazy until consumed.
      const result = Promise.resolve(verifying);
      await selected.promise;
      if (competitor === 'cancelled') {
        // Exercise the real cancellation transaction, including its row lock.
        app.use({ db: database });
        const cancelled = await app.app.inject({ method: 'DELETE', url: `/api/v1/orders/${ORDER_ID}` });
        assert.equal(cancelled.statusCode, 200);
      } else if (competitor === 'delivered') {
        await connection`UPDATE orders SET status = 'delivered' WHERE id = ${ORDER_ID}`;
      } else {
        await connection`UPDATE orders SET deleted_at = now() WHERE id = ${ORDER_ID}`;
      }
      resume.resolve();
      const response = await result;
      assert.equal(response.statusCode, 409, `${competitor} must win over the stale verification`);
      assert.equal(response.json().error.code, 'CONFLICT');
      const [stored] = await database.select().from(orders);
      assert.equal(stored?.status, competitor === 'deleted' ? 'processing' : competitor);
      assert.equal(stored?.deletedAt !== null, competitor === 'deleted');
    }
  } finally {
    await app.close();
    await connection.end();
  }
});

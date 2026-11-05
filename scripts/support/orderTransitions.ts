import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { orders } from '../../src/db/schema/index.js';
import { neonFixture } from './neonFixture.js';
import { buildSyncApplication } from './syncApp.js';
import { deferred, observeSelect } from './observeSelect.js';

export async function verifyConcurrentOrderTransitions() {
  const f = await neonFixture();
  try {
    let number = 0;
    for (const competitor of ['cancelled', 'delivered', 'deleted'] as const) {
      const id = randomUUID();
      await f.admin.insert(orders).values({ id, shopId: f.shopId, userId: f.userId, orderNumber: ++number });
      const selected = deferred();
      const resume = deferred();
      const database = observeSelect(f.application, orders, async () => {
        selected.resolve();
        await resume.promise;
      });
      const app = await buildSyncApplication(database, f.shop, f.userId, 'owner', { id: f.sessionId, secret: f.secret });
      const headers = { cookie: `neuton-dev-session=${f.secret}`, 'x-shop-id': f.shopId };
      const result = app.inject({ method: 'POST', url: `/api/v1/orders/${id}/verify`, headers });
      try {
        await Promise.race([selected.promise, result.then(response => {
          assert.fail(`Verification did not reach its real SELECT: ${response.statusCode}`);
        })]);
        if (competitor === 'cancelled') {
          const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/orders/${id}`, headers });
          assert.equal(cancelled.statusCode, 200, cancelled.body);
        } else if (competitor === 'delivered') {
          await f.admin.update(orders).set({ status: 'delivered' }).where(eq(orders.id, id));
        } else {
          await f.admin.update(orders).set({ deletedAt: new Date() }).where(eq(orders.id, id));
        }
        resume.resolve();
        const response = await result;
        assert.equal(response.statusCode, 409, `${competitor} must win over stale verification: ${response.body}`);
        assert.equal(response.json().error.code, 'CONFLICT');
        const [stored] = await f.admin.select().from(orders).where(eq(orders.id, id));
        assert.equal(stored?.status, competitor === 'deleted' ? 'processing' : competitor);
        assert.equal(stored?.deletedAt !== null, competitor === 'deleted');
      } finally {
        resume.resolve();
        await Promise.allSettled([result]);
        await app.close();
      }
    }
  } finally {
    await f.close();
  }
}

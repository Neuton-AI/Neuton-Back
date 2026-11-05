import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq, and } from 'drizzle-orm';
import { orders, auditLogs } from '../src/db/schema/index.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { OrdersPersistence } from '../src/modules/orders/orders.persistence.js';
import { OrdersAudit } from '../src/modules/orders/orders.audit.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { verifyConcurrentOrderTransitions } from './support/orderTransitions.js';

test('Nest order verification preserves concurrent outcomes and defers effects until outer commit', {
  skip: neonTestSkip, timeout: 120_000,
}, async () => {
  await verifyConcurrentOrderTransitions();
  const f = await neonFixture();
  try {
    const id = randomUUID();
    await f.admin.insert(orders).values({ id, shopId: f.shopId, userId: f.userId, orderNumber: 1 });
    const service = new OrdersService(new OrdersPersistence(f.application), new OrdersAudit());
    const effects: (() => Promise<void>)[] = [];
    const successLogs: unknown[] = [];
    const actor = { ...f.actor, log: { ...f.actor.log, info: (...args: unknown[]) => { successLogs.push(args); } } };
    const audits = () => f.admin.select().from(auditLogs).where(and(eq(auditLogs.shopId, f.shopId), eq(auditLogs.eventType, 'ORDER_DELIVERED')));
    await assert.rejects(f.inShop(async scope => {
      await service.inTransaction(scope, effect => effects.push(effect)).verify(actor, id);
      assert.equal((await audits()).length, 0, 'uncommitted audit is invisible to other connections');
      assert.equal(successLogs.length, 0);
      throw new Error('rollback outer sync');
    }), /rollback outer sync/);
    const [rolledBack] = await f.admin.select().from(orders).where(eq(orders.id, id));
    assert.equal(rolledBack?.status, 'processing');
    assert.equal((await audits()).length, 0);
    assert.equal(successLogs.length, 0);
    assert.equal(effects.length, 1);
    effects.length = 0;
    await f.inShop(async scope => {
      await service.inTransaction(scope, effect => effects.push(effect)).verify(actor, id);
      assert.equal((await audits()).length, 0);
      assert.equal(successLogs.length, 0);
    });
    assert.equal((await audits()).length, 1, 'audit commits atomically with the order');
    assert.equal(successLogs.length, 0, 'success logs wait for the caller to run committed effects');
    for (const effect of effects) await effect();
    assert.equal(successLogs.length, 1);
  } finally {
    await f.close();
  }
});

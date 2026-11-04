import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { processingDatabase } from './support/processingDatabase.js';
import { scheduleObjectDeletions, StorageCleanupDispatcher } from '../src/lib/storageCleanup.js';
import { withShopTransaction } from '../src/db/tenant-context.js';

// Exercise the actual migration chain under the cleanup role, with no services.
test('restricted cleanup leases, retries and survives document/shop deletion without table access', async () => {
  const fixture = await processingDatabase();
  const { database, application, cleanup, actor, outsideSql } = fixture;
  const dispatchers: StorageCleanupDispatcher[] = [];
  try {
    const path = `${actor.shop.id}/recipes/source.jpg`;
    const schedule = () => withShopTransaction(application, actor.session, actor.shop.id, scope =>
      scheduleObjectDeletions(scope.database, { shopId: scope.shopId, traceId: 'cleanup', paths: [path, path] }));
    const count = async () => Number((await database.query<{ count: number }>('select count(*)::integer as count from public.storage_object_deletions')).rows[0]!.count);
    const due = () => database.exec("update public.storage_object_deletions set next_attempt_at=now()-interval '1 second'");
    const dispatcher = (deleteObject: (key: string, signal?: AbortSignal) => Promise<void>, timeoutMs?: number) => {
      const value = new StorageCleanupDispatcher({ db: cleanup, deleteObject, log: actor.log, timeoutMs });
      dispatchers.push(value); return value;
    };
    await assert.rejects(cleanup.execute(sql`select * from public.storage_object_deletions`), /permission denied/);
    await assert.rejects(cleanup.execute(sql`select * from auth_private.users`), /permission denied/);
    await assert.rejects(withShopTransaction(application, actor.session, actor.shop.id, async scope => {
      await scheduleObjectDeletions(scope.database, { shopId: scope.shopId, traceId: 'rollback', paths: [path] });
      throw new Error('Rollback deletion');
    }), /Rollback deletion/);
    assert.equal(await count(), 0);
    await schedule(); assert.equal(await count(), 1);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const first = dispatcher(async key => { outsideSql(); assert.equal(key, path); calls++; entered(); await gate; });
    const second = dispatcher(async () => { outsideSql(); calls++; });
    const drain = first.drain(); await waiting;
    assert.equal(await second.drain(), 0);
    release(); await drain;
    assert.equal(calls, 1); assert.equal(await count(), 0);

    await schedule();
    const failing = dispatcher(async () => { outsideSql(); throw new Error('Storage unavailable'); });
    assert.equal(await failing.drain(), 1); assert.equal(await count(), 1);
    assert.equal(await second.drain(), 0);
    await due(); assert.equal(await second.drain(), 1); assert.equal(await count(), 0);

    await schedule();
    const lost = dispatcher(async () => {
      outsideSql();
      await database.query("update public.storage_object_deletions set lease_token=$1,lease_until=now()-interval '1 second'", [randomUUID()]);
    });
    await lost.drain(); assert.equal(await count(), 1);
    await second.drain(); assert.equal(await count(), 0);

    await schedule();
    const aborting = dispatcher(async (_key, signal) => new Promise((_resolve, reject) => {
      outsideSql(); signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }), 1);
    await aborting.drain(); assert.equal(await count(), 1);
    await due();
    let stoppingEntered!: () => void;
    const stoppingReady = new Promise<void>(resolve => { stoppingEntered = resolve; });
    const stopping = dispatcher(async (_key, signal) => new Promise((_resolve, reject) => {
      outsideSql(); signal!.addEventListener('abort', () => reject(new Error('Shutdown abort')), { once: true });
      stoppingEntered();
    }));
    const stoppingDrain = stopping.drain(); await stoppingReady;
    await stopping.stop(); await stoppingDrain;
    assert.equal(await count(), 1); assert.equal(await stopping.drain(), 0);
    await due();
    await database.query('delete from public.shops where id=$1', [actor.shop.id]);
    assert.equal(await second.drain(), 1); assert.equal(await count(), 0);
    await second.stop(); assert.equal(await second.drain(), 0);
  } finally {
    await Promise.all(dispatchers.map(value => value.stop()));
    await database.close();
  }
});

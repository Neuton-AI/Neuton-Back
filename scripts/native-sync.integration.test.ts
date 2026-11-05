import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { receipts } from '../src/db/schema/index.js';
import { isPlaceholder } from './support/testEnv.js';
import { SyncEvents } from '../src/modules/sync/sync-events.js';
import { PostgresSyncEvents } from '../src/modules/sync/postgres-sync-events.js';

test(
  'native PostgreSQL notifications commit, roll back, fan out and recover without a provider',
  {
    skip:
      neonTestSkip || (isPlaceholder('DATABASE_LISTEN_URL') && 'requires development DATABASE_LISTEN_URL'),
    timeout: 60000,
  },
  async () => {
    const f = await neonFixture();
    const url = process.env.DATABASE_LISTEN_URL!;
    const writer = f.ownerConnection;
    const listenerName = `neuton-test-${randomUUID()}`;
    const hubs = [new SyncEvents(), new SyncEvents()];
    const sources = hubs.map((hub) => new PostgresSyncEvents(url, hub, listenerName));
    const shop = f.shopId;
    const received: string[][] = [[], []];
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Notification timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      hubs.forEach((hub, index) =>
        hub.subscribe(shop, (event) => received[index]!.push(event)),
      );
      await Promise.all(sources.map((source) => source.ready()));
      received.forEach((events) => {
        events.length = 0;
      });
      await f.inShop(async ({ database }) => {
        await database.insert(receipts).values({ shopId: shop, storagePath: `${shop}/committed.png` });
        assert.equal(JSON.stringify(received), '[[],[]]');
      });
      await waitFor(() =>
        received.every((events) => events.includes('document-change')),
      );
      received.forEach((events) => {
        events.length = 0;
      });
      await assert.rejects(f.inShop(async ({ database }) => {
        await database.insert(receipts).values({ shopId: shop, storagePath: `${shop}/rolled-back.png` });
        throw new Error('rollback notification');
      }), /rollback notification/);
      // A committed notification is a delivery barrier for the rolled-back write.
      await writer`select pg_notify('neuton_document_changes',${shop})`;
      await waitFor(() => received.every((events) => events.length === 1));
      assert.equal(
        JSON.stringify(received),
        '[["document-change"],["document-change"]]',
      );
      await writer`select pg_terminate_backend(pid) from pg_stat_activity
        where application_name=${listenerName} and pid<>pg_backend_pid()`;
      await waitFor(() =>
        received.every((events) => events.includes('unavailable')),
      );
      await Promise.all(sources.map((source) => source.ready()));
      assert.ok(received.every((events) => events.includes('reconcile')));
    } finally {
      await Promise.all(sources.map((source) => source.close()));
      await f.close();
    }
  },
);

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { SyncEvents } from '../src/modules/sync/sync-events.js';
import { PostgresSyncEvents } from '../src/modules/sync/postgres-sync-events.js';

test(
  'native PostgreSQL notifications commit, roll back, fan out and recover without a provider',
  {
    skip:
      !process.env.NATIVE_SYNC_TEST_DATABASE_URL &&
      'Requires a disposable NATIVE_SYNC_TEST_DATABASE_URL',
    timeout: 20000,
  },
  async () => {
    const url = process.env.NATIVE_SYNC_TEST_DATABASE_URL!;
    const writer = new Client({ connectionString: url });
    const hubs = [new SyncEvents(), new SyncEvents()];
    const sources = hubs.map((hub) => new PostgresSyncEvents(url, hub));
    const schema = `sync_${randomUUID().replaceAll('-', '')}`;
    const shop = randomUUID();
    const received: string[][] = [[], []];
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Notification timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await writer.connect();
    try {
      await writer.query(
        `CREATE SCHEMA ${schema}; SET search_path TO ${schema}`,
      );
      await writer.query(
        'CREATE TABLE document_versions(shop_id uuid, id uuid, updated_at bigint)',
      );
      const migration = await readFile(
        new URL('../drizzle/0031_native_document_events.sql', import.meta.url),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint'))
        await writer.query(statement);
      hubs.forEach((hub, index) =>
        hub.subscribe(shop, (event) => received[index]!.push(event)),
      );
      await Promise.all(sources.map((source) => source.ready()));
      received.forEach((events) => {
        events.length = 0;
      });
      await writer.query('BEGIN');
      await writer.query('INSERT INTO document_versions VALUES ($1,$2,1)', [
        shop,
        randomUUID(),
      ]);
      assert.equal(JSON.stringify(received), '[[],[]]');
      await writer.query('COMMIT');
      await waitFor(() =>
        received.every((events) => events.includes('document-change')),
      );
      received.forEach((events) => {
        events.length = 0;
      });
      await writer.query('BEGIN');
      await writer.query('UPDATE document_versions SET updated_at=2');
      await writer.query('ROLLBACK');
      // A subsequent committed signal is a delivery barrier for the rolled-back write.
      await writer.query("SELECT pg_notify('neuton_document_changes',$1)", [
        shop,
      ]);
      await waitFor(() => received.every((events) => events.length === 1));
      assert.equal(
        JSON.stringify(received),
        '[["document-change"],["document-change"]]',
      );
      await writer.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='neuton-sync-listener' AND pid <> pg_backend_pid()",
      );
      await waitFor(() =>
        received.every((events) => events.includes('unavailable')),
      );
      await Promise.all(sources.map((source) => source.ready()));
      assert.ok(received.every((events) => events.includes('reconcile')));
    } finally {
      await Promise.all(sources.map((source) => source.close()));
      await writer.query(`DROP SCHEMA ${schema} CASCADE`);
      await writer.end();
    }
  },
);

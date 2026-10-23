import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Job } from 'bullmq';
import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import { ReceiptsPersistence } from '../src/modules/receipts/receipts.persistence.js';
import { runJob, type WorkerDeps } from '../src/worker.js';
import type { MediaJobData } from '../src/lib/queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Pause after the actual SELECT has acquired its row lock, not before executing it. */
function observe(
  database: Database,
  table: unknown,
  onRows: () => Promise<void>,
): Database {
  let observed = false;
  const query = (target: object, match = false): object =>
    new Proxy(target, {
      get(object, key) {
        if (key === 'then')
          return (
            resolve: (rows: unknown) => void,
            reject: (error: unknown) => void,
          ) => {
            Promise.resolve(object)
              .then(async (rows) => {
                if (match && !observed) {
                  observed = true;
                  await onRows();
                }
                return rows;
              })
              .then(resolve, reject);
          };
        const value = Reflect.get(object, key);
        return typeof value === 'function'
          ? (...args: unknown[]) =>
              query(
                value.apply(object, args),
                key === 'from' ? args[0] === table : match,
              )
          : value;
      },
    });
  return new Proxy(database, {
    get(object, key) {
      if (key === 'transaction')
        return (run: (tx: Database) => Promise<unknown>) =>
          object.transaction((tx) =>
            run(observe(tx as unknown as Database, table, onRows)),
          );
      const value = Reflect.get(object, key);
      if (key === 'select')
        return (...args: unknown[]) => query(value.apply(object, args));
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}
const url = process.env.API_ALIGNMENT_TEST_DATABASE_URL;
test(
  'receipt deletion and grouped worker agree on document-before-upload locks',
  {
    skip: !url && 'requires disposable API_ALIGNMENT_TEST_DATABASE_URL',
    timeout: 15000,
  },
  async () => {
    const namespace = `worker_delete_${randomUUID().replaceAll('-', '')}`;
    const connection = postgres(url!, {
      max: 4,
      onnotice() {},
      connection: { search_path: namespace },
    });
    const shopId = randomUUID(),
      receiptId = randomUUID(),
      uploadId = randomUUID();
    const storagePath = `${shopId}/receipts/page.jpg`;
    try {
      await connection.unsafe(`create schema ${namespace};
      create table ${namespace}.receipts(like public.receipts including all);
      create table ${namespace}.media_uploads(like public.media_uploads including all);
      alter table ${namespace}.media_uploads add foreign key(receipt_id) references ${namespace}.receipts(id) on delete cascade;
      create table ${namespace}.storage_object_deletions(like public.storage_object_deletions including all);`);
      await connection`insert into receipts(id,shop_id,storage_path,status) values(${receiptId},${shopId},${storagePath},'pending')`;
      const sources = [
        {
          sourceId: randomUUID(),
          storagePath,
          contentType: 'image/jpeg',
          originalFilename: 'page.jpg',
          byteSize: 2,
        },
      ];
      await connection`insert into media_uploads(id,shop_id,kind,sources,receipt_id,queued_at)
      values(${uploadId},${shopId},'receipt',${connection.json(sources)},${receiptId},now())`;
      const database = drizzle(connection, { schema });
      const locked = deferred(),
        release = deferred(),
        associated = deferred();
      const deleting = new ReceiptsPersistence(
        observe(database, schema.receipts, async () => {
          locked.resolve();
          await release.promise;
        }),
      ).delete(shopId, receiptId, 'worker-delete-test');
      await locked.promise;
      const workerDb = observe(database, schema.mediaUploads, async () => {
        associated.resolve();
      });
      const data: MediaJobData = {
        uploadId,
        shopId,
        uploadedBy: null,
        kind: 'receipt',
        storagePath,
        contentType: 'image/jpeg',
        originalFilename: 'page.jpg',
      };
      let extracted = 0;
      const working = runJob(
        data,
        {
          id: 'worker-delete',
          updateProgress: async () => {},
        } as unknown as Job<MediaJobData>,
        {
          db: workerDb,
          getObjectBytes: async () => {
            extracted++;
            return new Uint8Array([1, 2]);
          },
          extractReceipt: async () => {
            assert.fail('deleted document must not be extracted');
          },
        } as unknown as WorkerDeps,
      );
      await associated.promise;
      release.resolve();
      await Promise.all([deleting, working]);
      assert.equal(extracted, 0);
      assert.equal(
        (await connection`select count(*)::int as count from receipts`)[0]
          ?.count,
        0,
      );
      assert.equal(
        (
          await connection`select count(*)::int as count from storage_object_deletions`
        )[0]?.count,
        1,
      );
    } finally {
      await connection.unsafe(`drop schema if exists ${namespace} cascade`);
      await connection.end({ timeout: 5 });
    }
  },
);

import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { createDatabaseConnection } from '../src/db/connection.js';
import { ReceiptsPersistence } from '../src/modules/receipts/receipts.persistence.js';
import { presignDocument, completeDocument, type MediaUploadDeps } from '../src/lib/mediaUploads.js';
import { defaultWorkerServices } from '../src/modules/processing/processing.service.js';
import { runJob } from '../src/worker.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { deferred, observeSelect } from './support/observeSelect.js';

test('receipt deletion and grouped worker agree on document-before-upload locks', {
  skip: neonTestSkip || (!process.env.WORKER_DATABASE_URL && 'requires development WORKER_DATABASE_URL'),
  timeout: 60_000,
}, async () => {
  const f = await neonFixture();
  const workerConnection = createDatabaseConnection('worker');
  const released = deferred();
  let deleting: Promise<unknown> | undefined;
  let working: Promise<unknown> | undefined;
  try {
    const uploadId = randomUUID();
    const uploads: MediaUploadDeps = { db: f.application,
      createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => ({ byteSize: 2, contentType: 'image/jpeg' }),
      enqueueMediaJob: async data => ({ queued: true, jobId: data.jobId! }),
    };
    const upload = await presignDocument(uploads, { actor: f.actor, shopId: f.shopId, userId: f.userId,
      currency: f.shop.currency, body: { clientRequestId: uploadId, kind: 'receipt',
        sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
    await completeDocument(uploads, { actor: f.actor, shopId: f.shopId, body: { uploadId } });
    const locked = deferred();
    deleting = f.inShop(scope => new ReceiptsPersistence({ ...scope,
      database: observeSelect(scope.database, schema.receipts, async () => {
        locked.resolve();
        await released.promise;
      }),
    }).delete(f.shopId, upload.receiptId!, 'worker-delete-test'));
    await Promise.race([locked.promise, deleting.then(() => assert.fail('Deletion never acquired its receipt lock'))]);
    const associated = deferred();
    const worker = observeSelect(drizzle(workerConnection, { schema }), schema.mediaUploads, async () => { associated.resolve(); });
    let extracted = 0;
    working = runJob({ jobId: `upload-${uploadId}` }, { id: `upload-${uploadId}`, updateProgress: async () => {} }, {
      ...defaultWorkerServices, db: worker,
      getObjectBytes: async () => { extracted++; return new Uint8Array([1, 2]); },
      extractReceipt: async () => { assert.fail('deleted document must not be extracted'); },
    });
    await Promise.race([associated.promise, working.then(() => assert.fail('Worker never loaded its persisted association'))]);
    released.resolve();
    await Promise.all([deleting, working]);
    assert.equal(extracted, 0);
    assert.equal((await f.admin.select().from(schema.receipts).where(eq(schema.receipts.id, upload.receiptId!))).length, 0);
    const cleanup = await f.admin.select().from(schema.storageObjectDeletions).where(eq(schema.storageObjectDeletions.shopId, f.shopId));
    const path = upload.sources[0]!.storagePath;
    assert.deepEqual(cleanup.map(row => row.storagePath).sort(), [path, `${path}.preview-v1.webp`].sort());
  } finally {
    released.resolve();
    await Promise.allSettled([deleting, working]);
    try { await workerConnection.end({ timeout: 5 }); } finally { await f.close(); }
  }
});

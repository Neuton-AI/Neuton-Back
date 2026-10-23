import './support/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentProcessingService,
  type WorkerDeps,
} from '../src/modules/processing/processing.service.js';
import { workerLogger, LoggerImpl } from '../src/lib/logger/index.js';
import { FakeDb } from './support/fakeDb.js';
import type { MediaJobData } from '../src/lib/queue.js';
const shopId = '11111111-1111-1111-1111-111111111111',
  id = '22222222-2222-2222-2222-222222222222',
  path = `${shopId}/receipts/a.jpg`;
test('processing success waits for the durable processed marker to commit', async () => {
  const events: string[] = [];
  const original = workerLogger.child;
  workerLogger.child = () =>
    new LoggerImpl(
      {
        write: (_level, message) => {
          events.push(message ?? '');
        },
      },
      {},
      'debug',
    );
  const run = async (fail: boolean) => {
    const upload = {
      id,
      shopId,
      kind: 'receipt',
      receiptId: id,
      recipeId: null,
      orderId: null,
      queuedAt: new Date(),
      processedAt: null,
      sources: [
        {
          sourceId: id,
          storagePath: path,
          contentType: 'image/jpeg',
          originalFilename: null,
          byteSize: 1,
        },
      ],
    };
    const db = new FakeDb({
      'select:mediaUploads': [[upload], [upload]],
      'select:receipts': [[{ id }], [{ id }]],
    });
    if (fail)
      db.failOn('update', 'mediaUploads', new Error('processed marker failed'));
    const deps = {
      db,
      getObjectBytes: async () => new Uint8Array([1]),
      extractReceipt: async () => ({
        merchantName: null,
        receiptDate: null,
        totalAmount: 0,
        taxAmount: null,
        currency: 'USD',
        items: [],
      }),
      searchProduct: async () => [],
    } as unknown as WorkerDeps;
    return new DocumentProcessingService(deps).run(
      {
        uploadId: id,
        shopId,
        uploadedBy: null,
        kind: 'receipt',
        storagePath: path,
        contentType: 'image/jpeg',
        originalFilename: null,
      } satisfies MediaJobData,
      { id: 'job', updateProgress: async () => {} },
    );
  };
  try {
    await assert.rejects(run(true), /processed marker failed/);
    assert.equal(
      events.includes('receipt extracted, awaiting verification'),
      false,
    );
    await run(false);
    assert.equal(
      events.includes('receipt extracted, awaiting verification'),
      true,
    );
  } finally {
    workerLogger.child = original;
  }
});

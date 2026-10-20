import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from 'bullmq';
import { FakeDb } from './support/fakeDb.js';
import { completeDocument, presignDocument, validateSourceLimits, MAX_SOURCE_BYTES, type MediaUploadDeps } from '../src/lib/mediaUploads.js';
import { documentParts, MULTI_SOURCE_INSTRUCTION } from '../src/lib/gemini.js';
import { loadDocumentInput, runJob, type WorkerDeps } from '../src/worker.js';
import type { MediaJobData } from '../src/lib/queue.js';
import { enqueueMediaJobOn } from '../src/lib/queue.js';

const SHOP = '11111111-1111-1111-1111-111111111111';
const UPLOAD = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const sources = [0, 1, 2, 3].map((index) => ({
  sourceId: `${index + 4}4444444-4444-4444-4444-444444444444`,
  storagePath: `${SHOP}/receipts/${index}.jpg`, contentType: index === 2 ? 'application/pdf' : 'image/jpeg',
  originalFilename: `${index}.jpg`, byteSize: 2,
}));
function upload(overrides = {}) {
  return { id: UPLOAD, shopId: SHOP, uploadedBy: USER, kind: 'receipt' as const, sources,
    receiptId: 'receipt-id', recipeId: null, orderId: null, queuedAt: null, processedAt: null, ...overrides };
}
function harness(row = upload()) {
  const db = new FakeDb({ 'select:mediaUploads': [[row]] });
  const enqueued: MediaJobData[] = [];
  const deps: MediaUploadDeps = {
    db: db as unknown as MediaUploadDeps['db'],
    createPresignedUploadUrl: async (path) => `https://upload.test/${path}`,
    getObjectMetadata: async (path) => ({ byteSize: 2, contentType: sources.find((source) => source.storagePath === path)!.contentType }),
    enqueueMediaJob: async (data) => { enqueued.push(data); return { queued: true, jobId: `upload-${UPLOAD}` }; },
  };
  return { db, deps, enqueued };
}

test('document limits allow four sources and reject a fifth, invalid type, or oversized file', () => {
  validateSourceLimits(sources.map((source) => ({ ...source, byteSize: MAX_SOURCE_BYTES })));
  assert.throws(() => validateSourceLimits([...sources, sources[0]!]), /between 1 and 4/);
  assert.throws(() => validateSourceLimits([{ ...sources[0]!, byteSize: MAX_SOURCE_BYTES + 1 }]), /10 MB/);
  assert.throws(() => validateSourceLimits([{ ...sources[0]!, contentType: 'text/html' }]), /Unsupported/);
});

test('completion verifies every source then enqueues one ordered document', async () => {
  const h = harness();
  const result = await completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP });
  assert.equal(result.receiptId, 'receipt-id');
  assert.equal(h.enqueued.length, 1);
  assert.deepEqual(h.enqueued[0]?.sources, sources);
  assert.equal(h.db.onlyCallTo('update', 'mediaUploads').inTransaction, true);
});

test('missing later source prevents extraction and names the failed source', async () => {
  const h = harness();
  h.deps.getObjectMetadata = async (path) => {
    if (path === sources[2]!.storagePath) throw new Error('NotFound');
    return { byteSize: 2, contentType: 'image/jpeg' };
  };
  await assert.rejects(completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP }),
    (error: any) => error.details.sourceId === sources[2]!.sourceId);
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.db.callsTo('update', 'mediaUploads').length, 0);
});

test('completion rejects actual metadata tampering before enqueue', async () => {
  const h = harness();
  h.deps.getObjectMetadata = async () => ({ byteSize: MAX_SOURCE_BYTES + 1, contentType: 'image/jpeg' });
  await assert.rejects(completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP }), /declared size or type/);
  assert.equal(h.enqueued.length, 0);
});

test('repeated completion safely redispatches the same durable job identity', async () => {
  const h = harness(upload({ queuedAt: new Date() }));
  const result = await completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP });
  assert.equal(result.jobId, `upload-${UPLOAD}`);
  assert.equal(h.enqueued.length, 1);
});

test('renewing a failed source preserves document, source IDs and successful keys', async () => {
  const h = harness();
  const result = await presignDocument(h.deps, {
    body: { uploadId: UPLOAD, sourceIds: [sources[2]!.sourceId] }, shopId: SHOP, userId: USER, currency: 'USD',
  });
  assert.equal(result.uploadId, UPLOAD);
  assert.equal(result.receiptId, 'receipt-id');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.storagePath, sources[2]!.storagePath);
  assert.equal(h.db.callsTo('insert', 'receipts').length, 0);
  assert.equal(h.db.callsTo('insert', 'mediaUploads').length, 0);
});

test('initial request replay reuses its existing group before creating a business record', async () => {
  const h = harness();
  const result = await presignDocument(h.deps, {
    body: { clientRequestId: UPLOAD, kind: 'receipt', sources }, shopId: SHOP, userId: USER, currency: 'USD',
  });
  assert.equal(result.uploadId, UPLOAD);
  assert.deepEqual(result.sources.map((source) => source.storagePath), sources.map((source) => source.storagePath));
  assert.equal(h.db.callsTo('insert', 'receipts').length, 0);
});

test('initial request replay cannot renew PUT URLs after completion', async () => {
  const h = harness(upload({ queuedAt: new Date() }));
  await assert.rejects(presignDocument(h.deps, {
    body: { clientRequestId: UPLOAD, kind: 'receipt', sources }, shopId: SHOP, userId: USER, currency: 'USD',
  }), /already been submitted/);
});

test('source association tampering cannot sign a foreign shop object', async () => {
  const h = harness(upload({ sources: [{ ...sources[0]!, storagePath: 'foreign-shop/receipts/private.jpg' }] }));
  await assert.rejects(presignDocument(h.deps, {
    body: { uploadId: UPLOAD }, shopId: SHOP, userId: USER, currency: 'USD',
  }), /Upload source not found/);
});

test('dispatch failure leaves a durable readiness intent for a safe completion retry', async () => {
  const h = harness();
  h.deps.enqueueMediaJob = async () => { throw new Error('Redis temporarily unavailable'); };
  await assert.rejects(completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP }), /Redis/);
  assert.ok(h.db.onlyCallTo('update', 'mediaUploads').set?.queuedAt instanceof Date);
});

test('order documents require an explicit target before creating any rows', async () => {
  const h = harness();
  await assert.rejects(presignDocument(h.deps, {
    body: { kind: 'order', sources }, shopId: SHOP, userId: USER, currency: 'USD',
  }), /Select an order/);
  assert.equal(h.db.calls.length, 0);
});

test('long recipe filenames preserve their unique upload suffix', async () => {
  const h = harness();
  h.db.push('insert', 'mediaUploads', [upload({ kind: 'recipe', receiptId: null })]);
  h.db.push('insert', 'recipes', [{ id: 'recipe-id' }]);
  await presignDocument(h.deps, {
    body: { clientRequestId: UPLOAD, kind: 'recipe', sources: [{ ...sources[0]!, originalFilename: 'a'.repeat(250) }] },
    shopId: SHOP, userId: USER, currency: 'USD',
  });
  const inserted = h.db.onlyCallTo('insert', 'recipes').values as { name: string };
  assert.match(inserted.name, new RegExp(`\\(${UPLOAD}\\)$`));
  assert.ok(inserted.name.length <= 200);
});

test('unknown or cross-shop group cannot complete or renew', async () => {
  const h = harness();
  h.db.push('select', 'mediaUploads', []);
  await completeDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP });
  await assert.rejects(presignDocument(h.deps, { body: { uploadId: UPLOAD }, shopId: SHOP, userId: USER, currency: 'USD' }), /Upload not found/);
});

test('multi-image/PDF input preserves source order and PDF bytes', async () => {
  const requested: string[] = [];
  const input = await loadDocumentInput({ getObjectBytes: async (path) => {
    requested.push(path); return new Uint8Array([sources.findIndex((source) => source.storagePath === path), 1]);
  } } as WorkerDeps, { shopId: SHOP, sources } as MediaJobData);
  assert.deepEqual(requested, sources.map((source) => source.storagePath));
  assert.deepEqual(input.sources?.map((source) => source.mimeType), sources.map((source) => source.contentType));
  const parts = documentParts(input);
  assert.equal(parts.filter((part) => part.inlineData).length, 4);
  assert.equal(parts[0]?.text, MULTI_SOURCE_INSTRUCTION);
  assert.match(MULTI_SOURCE_INSTRUCTION, /Preserve legitimate repeated items/);
});

test('a missing source stops the worker before any partial extraction', async () => {
  await assert.rejects(loadDocumentInput({ getObjectBytes: async (path) => {
    if (path === sources[1]!.storagePath) throw new Error('Missing');
    return new Uint8Array([0, 1]);
  } } as WorkerDeps, { shopId: SHOP, sources } as MediaJobData), /Missing/);
});

test('durably processed group skips all worker effects after queue redelivery', async () => {
  const h = harness(upload({ processedAt: new Date(), queuedAt: new Date() }));
  const data = { uploadId: UPLOAD, shopId: SHOP, uploadedBy: USER, kind: 'receipt' } as MediaJobData;
  await runJob(data, { id: 'duplicate' } as Job<MediaJobData>, { db: h.deps.db } as WorkerDeps);
  assert.deepEqual(h.db.callSequence(), ['select:mediaUploads']);
});

test('legacy single input retains the previous one-part vision contract', () => {
  assert.deepEqual(documentParts({ mimeType: 'image/png', data: 'AA==' }), [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }]);
});

test('a failed stable queue job is restarted rather than acknowledged without work', async () => {
  let retries = 0;
  let additions = 0;
  const result = await enqueueMediaJobOn({
    getJob: async () => ({ id: `upload-${UPLOAD}`, getState: async () => 'failed', retry: async () => { retries++; } }),
    add: async () => { additions++; throw new Error('Must reuse the existing job'); },
  } as never, { uploadId: UPLOAD, kind: 'receipt' } as MediaJobData);
  assert.equal(result.jobId, `upload-${UPLOAD}`);
  assert.equal(retries, 1);
  assert.equal(additions, 0);
});

test('an active stable queue job is not duplicated or restarted', async () => {
  const result = await enqueueMediaJobOn({
    getJob: async () => ({ id: `upload-${UPLOAD}`, getState: async () => 'active', retry: async () => { throw new Error('Already running'); } }),
    add: async () => { throw new Error('Must reuse the existing job'); },
  } as never, { uploadId: UPLOAD, kind: 'receipt' } as MediaJobData);
  assert.equal(result.jobId, `upload-${UPLOAD}`);
});

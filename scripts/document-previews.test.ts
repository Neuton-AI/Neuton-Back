import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createDocumentPreview, prepareSourcePreviews, previewStoragePath, sourceStoragePaths } from '../src/lib/documentPreviews.js';
import { processGroup } from '../src/modules/processing/processing.persistence.js';
import type { WorkerDeps } from '../src/modules/processing/processing.service.js';
import type { MediaJobData } from '../src/lib/queue.js';
import { FakeDb } from './support/fakeDb.js';

const source = { sourceId: 'source-1', storagePath: 'shop/receipts/scan.png', contentType: 'image/png', originalFilename: 'scan.png', byteSize: 1 };

test('image previews are bounded WebP, preserve aspect ratio, and save bytes', async () => {
  const input = await sharp({ create: { width: 2400, height: 3600, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await createDocumentPreview(input, 'image/png');
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 1200);
  assert.ok(result.bytes.length < input.length);
});

test('small images are not enlarged and unsupported bytes fail safely', async () => {
  const input = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } }).png().toBuffer();
  const result = await createDocumentPreview(input, 'image/png');
  assert.equal(result.width, 100);
  assert.equal(result.height, 200);
  await assert.rejects(createDocumentPreview(Buffer.from('invalid'), 'image/heic'));
});

test('source previews retain order, reuse metadata, and isolate a failed source', async () => {
  const existing = { storagePath: 'shop/existing.webp', contentType: 'image/webp' as const, width: 10, height: 20 };
  const sources = [source, { ...source, sourceId: 'source-2', preview: existing }, { ...source, sourceId: 'source-3' }];
  const failed: string[] = [];
  const result = await prepareSourcePreviews(sources, async current => {
    if (current.sourceId === 'source-3') throw new Error('decoder failed');
    return { ...existing, storagePath: previewStoragePath(current.storagePath) };
  }, current => { failed.push(current.sourceId); });
  assert.deepEqual(result.map(current => current.sourceId), sources.map(current => current.sourceId));
  assert.equal(result[0]?.preview?.storagePath, 'shop/receipts/scan.png.preview-v1.webp');
  assert.deepEqual(result[1]?.preview, existing);
  assert.equal(result[2]?.preview, undefined);
  assert.deepEqual(failed, ['source-3']);
});

test('cleanup includes deterministic preview keys even after metadata rollback', () => {
  assert.deepEqual(sourceStoragePaths(source), [source.storagePath, previewStoragePath(source.storagePath)]);
});

test('group processing reuses original bytes, persists preview metadata, and redelivery skips generation', async () => {
  const row = { id: 'upload', kind: 'receipt', receiptId: 'receipt', queuedAt: new Date(), processedAt: null, sources: [source] };
  const db = new FakeDb({ 'select:mediaUploads': [[row], [row]], 'select:receipts': [[{ id: 'receipt' }]] });
  let reads = 0;
  const preview = { storagePath: previewStoragePath(source.storagePath), contentType: 'image/webp' as const, width: 100, height: 200 };
  const deps = { db, getObjectBytes: async () => { reads++; return new Uint8Array([1]); },
    createSourcePreview: async (_source: unknown, bytes: Uint8Array) => { assert.deepEqual([...bytes], [1]); return preview; } } as unknown as WorkerDeps;
  const data = { uploadId: 'upload', shopId: 'shop' } as MediaJobData;
  await processGroup(deps, data, async (current) => { await current.getObjectBytes(source.storagePath); });
  assert.equal(reads, 1);
  const saved = db.onlyCallTo('update', 'mediaUploads').set!;
  assert.deepEqual(saved.sources, [{ ...source, preview }]);
  assert.ok(saved.processedAt instanceof Date);
  db.push('select', 'mediaUploads', [{ ...row, processedAt: new Date() }]);
  await processGroup(deps, data, async () => { throw new Error('Must skip processed upload'); });
  assert.equal(reads, 1);
});

test('group commits extraction when preview generation fails', async () => {
  const row = { id: 'upload', kind: 'receipt', receiptId: 'receipt', queuedAt: new Date(), sources: [source] };
  const db = new FakeDb({ 'select:mediaUploads': [[row], [row]], 'select:receipts': [[{ id: 'receipt' }]] });
  await processGroup({ db, getObjectBytes: async () => new Uint8Array([1]),
    createSourcePreview: async () => { throw new Error('renderer unavailable'); } } as unknown as WorkerDeps,
    { uploadId: 'upload', shopId: 'shop' } as MediaJobData, async current => { await current.getObjectBytes(source.storagePath); });
  const saved = db.onlyCallTo('update', 'mediaUploads').set!;
  assert.deepEqual(saved.sources, [source]);
  assert.ok(saved.processedAt instanceof Date);
});

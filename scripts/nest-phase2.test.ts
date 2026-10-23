import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { Module } from '@nestjs/common';
import type { Database } from '../src/db/client.js';
import type { Receipt, ReceiptItem } from '../src/db/schema/receipts.js';
import { FakeDb } from './support/fakeDb.js';
import {
  buildNestPhase2App,
  SHOP_ID,
  USER_ID,
} from './support/nestPhase2App.js';
import { CatalogModule } from '../src/modules/catalog/catalog.module.js';
import { ReceiptsModule } from '../src/modules/receipts/receipts.module.js';
import { UploadsModule } from '../src/modules/uploads/uploads.module.js';
import { createHttpApplication } from '../src/http/application.js';
const ID = '55555555-5555-5555-5555-555555555555';
const UPLOAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const date = new Date('2026-01-01');
const receipt: Receipt = {
  id: ID,
  shopId: SHOP_ID,
  uploadedBy: USER_ID,
  storagePath: `${SHOP_ID}/receipts/a.jpg`,
  contentType: 'image/jpeg',
  originalFilename: 'receipt.jpg',
  merchantName: 'User merchant',
  merchantAddress: null,
  receiptDate: '2026-01-01',
  paymentMethod: null,
  totalAmount: '12.34',
  taxAmount: '1.00',
  currency: 'USD',
  status: 'unverified',
  progressStage: 'completed',
  progressMessage: null,
  processingStartedAt: date,
  processingDeadline: date,
  errorMessage: null,
  processedAt: date,
  verifiedBy: null,
  verifiedAt: null,
  createdAt: date,
  updatedAt: date,
};
const item: ReceiptItem = {
  id: ID,
  shopId: SHOP_ID,
  receiptId: ID,
  inventoryItemId: null,
  rawName: 'User corrected flour',
  rawMaterialName: 'flour',
  rawSku: null,
  quantity: '2.000',
  unitPrice: '6.1700',
  totalPrice: '12.34',
  rawSrcUnit: 'kg',
  srcUnit: 'kg',
  srcUnitAmount: '1.000',
  baseUnit: 'g',
  baseUnitAmount: '2000.000',
  baseUnitCost: '0.006170',
  confidence: null,
  createdAt: date,
};
const source = {
  sourceId: UPLOAD,
  storagePath: receipt.storagePath!,
  contentType: 'image/jpeg',
  originalFilename: 'receipt.jpg',
  byteSize: 8,
};
const headers = { authorization: 'Bearer test', 'x-shop-id': SHOP_ID };

test('production feature modules compose with explicit Nest injection', async () => {
  @Module({ imports: [CatalogModule, ReceiptsModule, UploadsModule] })
  class Root {}
  const app = await createHttpApplication(Root, {
    origins: [],
    bodyLimit: 100000,
    rateLimit: { max: 100, windowMs: 60000 },
  });
  try {
    assert.equal(
      (await request(app.getHttpServer()).get('/api/v1/receipts')).status,
      401,
    );
  } finally {
    await app.close();
  }
});
test('Nest receipts preserve explicit decimal/date and reviewed nested fields', async () => {
  const db = new FakeDb({
    'select:receipts': [
      [{ ...receipt, privateColumn: 'hidden' }],
      [receipt],
      [receipt],
      [{ count: 2 }],
    ],
    'select:receiptItems': [[{ ...item, privateColumn: 'hidden' }]],
    'select:mediaUploads': [
      [{ sources: [{ ...source, privateColumn: 'hidden' }] }],
    ],
  });
  const h = await buildNestPhase2App(db as unknown as Database, 'member');
  try {
    const list = await request(h.app.getHttpServer())
      .get('/api/v1/receipts')
      .set(headers);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, {
      receipts: [JSON.parse(JSON.stringify(receipt))],
    });
    const detail = await request(h.app.getHttpServer())
      .get(`/api/v1/receipts/${ID}`)
      .set(headers);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body, {
      receipt: {
        ...JSON.parse(JSON.stringify(receipt)),
        items: [JSON.parse(JSON.stringify(item))],
        sources: [source],
      },
    });
    const status = await request(h.app.getHttpServer())
      .get(`/api/v1/receipts/${ID}/status`)
      .set(headers);
    assert.equal(status.status, 200);
    assert.equal(status.body.processingStartedAt, date.toISOString());
    assert.equal('merchantName' in status.body, false);
    assert.deepEqual(
      (
        await request(h.app.getHttpServer())
          .get('/api/v1/receipts/queue/pending-count')
          .set(headers)
      ).body,
      { pending: 2 },
    );
  } finally {
    await h.close();
  }
});
test('Nest grouped uploads reject old payloads and redispatch stable identities after readiness commit', async () => {
  const upload = {
    id: UPLOAD,
    shopId: SHOP_ID,
    uploadedBy: USER_ID,
    kind: 'receipt',
    receiptId: ID,
    recipeId: null,
    orderId: null,
    sources: [source],
    queuedAt: null,
    processedAt: null,
    createdAt: date,
  };
  const db = new FakeDb({
    'select:mediaUploads': [
      [upload],
      [{ ...upload, queuedAt: date }],
      [{ ...upload, queuedAt: date }],
    ],
  });
  const h = await buildNestPhase2App(db as unknown as Database);
  try {
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .post('/api/v1/uploads/presign')
          .set(headers)
          .send({ kind: 'receipt', contentType: 'image/jpeg' })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .post('/api/v1/uploads/complete')
          .set(headers)
          .send({ kind: 'receipt', storagePath: source.storagePath })
      ).status,
      400,
    );
    assert.equal(db.calls.length, 0);
    const signed = await request(h.app.getHttpServer())
      .post('/api/v1/uploads/presign')
      .set(headers)
      .send({ uploadId: UPLOAD });
    assert.equal(signed.status, 201);
    assert.equal(signed.body.sources[0].sourceId, UPLOAD);
    for (let attempt = 0; attempt < 2; attempt++) {
      const complete = await request(h.app.getHttpServer())
        .post('/api/v1/uploads/complete')
        .set(headers)
        .send({ uploadId: UPLOAD });
      assert.equal(complete.status, 202);
      assert.equal(complete.body.jobId, `upload-${UPLOAD}`);
    }
    assert.equal(h.dispatched.length, 2);
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .post('/api/v1/uploads/download-url')
          .set(headers)
          .send({ path: 'foreign/private.jpg' })
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});
test('Nest receipt deletion rejects verified documents and member writes before cleanup intent', async () => {
  const db = new FakeDb({
    'select:receipts': [[{ ...receipt, status: 'verified' }]],
  });
  const owner = await buildNestPhase2App(db as unknown as Database);
  const memberDb = new FakeDb();
  const member = await buildNestPhase2App(
    memberDb as unknown as Database,
    'member',
  );
  try {
    assert.equal(
      (
        await request(owner.app.getHttpServer())
          .delete(`/api/v1/receipts/${ID}`)
          .set(headers)
      ).status,
      409,
    );
    assert.equal(db.callsTo('insert', 'storageObjectDeletions').length, 0);
    assert.equal(
      (
        await request(member.app.getHttpServer())
          .delete(`/api/v1/receipts/${ID}`)
          .set(headers)
      ).status,
      403,
    );
    assert.equal(memberDb.calls.length, 0);
  } finally {
    await owner.close();
    await member.close();
  }
});

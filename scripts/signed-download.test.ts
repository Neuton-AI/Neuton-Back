import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { receipts } from '../src/db/schema/index.js';
import { UploadsService } from '../src/modules/uploads/uploads.service.js';
import { UploadsPersistence, defaultUploadServices } from '../src/modules/uploads/uploads.persistence.js';
import { createPresignedDownloadUrl } from '../src/lib/storage.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';

test('download authorization rejects foreign/unknown paths and signs a seeded owned path', { skip: neonTestSkip }, async () => {
  const f = await neonFixture();
  const signed: string[] = [];
  const service = new UploadsService(new UploadsPersistence({ ...defaultUploadServices,
    db: f.application,
    async createPresignedDownloadUrl(path) {
      signed.push(path);
      // Signing is local: no object is uploaded or downloaded.
      return createPresignedDownloadUrl(path);
    },
  }));
  try {
    const path = `${f.shopId}/receipts/owned.png`;
    await f.inShop(async ({ database }) => {
      await database.insert(receipts).values({ shopId: f.shopId, uploadedBy: f.userId, storagePath: path });
    });
    await assert.rejects(service.download(f.actor, `${randomUUID()}/receipts/foreign.png`), { statusCode: 403 });
    await assert.rejects(service.download(f.actor, `${f.shopId}/receipts/missing.png`), { statusCode: 404 });
    assert.deepEqual(signed, [], 'rejected paths never reach the signer');
    const download = await service.download(f.actor, path);
    const url = new URL(download.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.pathname.endsWith(path));
    assert.ok(url.searchParams.has('X-Amz-Signature'));
    assert.equal(download.expiresIn, 3600);
    assert.deepEqual(signed, [path]);
  } finally {
    await f.close();
  }
});

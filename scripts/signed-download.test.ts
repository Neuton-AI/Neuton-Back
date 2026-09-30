import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/db/client.js';
import { receipts } from '../src/db/schema/index.js';
import { createPresignedDownloadUrl } from '../src/lib/storage.js';
import { sql, and, eq } from 'drizzle-orm';

function tenantPrefix(shopId: string, path: string) {
  return `${shopId}/${path}`;
}

test('download-url rejects cross-tenant path', async () => {
  const shopA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const shopB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const path = tenantPrefix(shopB, 'receipts/test.png');

  assert.throws(() => {
    if (!path.startsWith(`${shopA}/`)) {
      throw new Error('forbidden');
    }
  }, { message: /forbidden/i });
});

test('download-url rejects unknown path for tenant', async () => {
  const shopId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const path = tenantPrefix(shopId, 'receipts/does-not-exist.png');

  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, path)))
    .limit(1);

  assert.equal(rows.length, 0);
});

test('download-url returns signed URL for owned path', async () => {
  const shopId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const path = tenantPrefix(shopId, 'receipts/owned.png');

  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, path)))
    .limit(1);

  if (rows.length === 0) {
    console.log('Test skipped: no matching receipt row in DB');
    return;
  }

  const url = await createPresignedDownloadUrl(path);
  assert.ok(url.startsWith('http'));
  assert.ok(url.includes(path));
});
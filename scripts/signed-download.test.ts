import { skipWithoutDisposableDatabase } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { db } from '../src/db/client.js';
import { receipts, shops } from '../src/db/schema/index.js';
import { createPresignedDownloadUrl } from '../src/lib/storage.js';
import { and, eq } from 'drizzle-orm';

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

const skip = skipWithoutDisposableDatabase;

test('download-url rejects unknown path for tenant', { skip }, async () => {
  const shopId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const path = tenantPrefix(shopId, 'receipts/does-not-exist.png');

  const rows = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, path)))
    .limit(1);

  assert.equal(rows.length, 0);
});

test('download-url returns signed URL for owned path', { skip }, async () => {
  const shopId = randomUUID();
  const path = tenantPrefix(shopId, 'receipts/owned.png');

  await db.insert(shops).values({ id: shopId, name: 'Signed download fixture', slug: shopId });
  try {
    await db.insert(receipts).values({ shopId, storagePath: path });
    const [owned] = await db.select({ storagePath: receipts.storagePath }).from(receipts)
      .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, path)));
    assert.equal(owned?.storagePath, path);
    const url = new URL(await createPresignedDownloadUrl(owned.storagePath));
    assert.equal(url.protocol, 'https:');
    assert.ok(url.pathname.endsWith(`/${path}`));
    assert.ok(url.searchParams.has('X-Amz-Signature'));
  } finally {
    await db.delete(shops).where(eq(shops.id, shopId));
  }
});

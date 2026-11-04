import './support/testEnv.js';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { inventoryItems, mediaUploads, profiles, shopMembers } from '../src/db/schema/index.js';
import { withShopTransaction } from '../src/db/tenant-context.js';
import { neonFixture } from './support/neonFixture.js';

// Uses the prepared development Neon role connections. All fixture IDs are fresh;
// only these accounts/shops are removed, including when an assertion fails.
const fixtures: Awaited<ReturnType<typeof neonFixture>>[] = [];
function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return databaseCode(error.cause);
  return undefined;
}
try {
  const owner = await neonFixture();
  fixtures.push(owner);
  const other = await neonFixture();
  fixtures.push(other);
  const member = await neonFixture();
  fixtures.push(member);
  const tenantTables = ['shops', 'profiles', 'shop_members', 'inventory_items', 'recipes',
    'categories', 'receipts', 'receipt_items', 'orders', 'order_items', 'recipe_ingredients',
    'audit_logs', 'media_uploads', 'document_versions', 'document_mutations',
    'inventory_adjustment_batches', 'product_measurements', 'ingredient_conversions'];
  const relations = await owner.ownerConnection<{ relname: string; enabled: boolean; forced: boolean }[]>`
    select relname,relrowsecurity as enabled,relforcerowsecurity as forced from pg_class
    where relnamespace='public'::regnamespace and relname=any(${tenantTables})`;
  assert.equal(relations.length, tenantTables.length, 'all expected tenant tables exist');
  assert.ok(relations.every(row => row.enabled && row.forced), 'tenant tables must enable and force RLS');
  const role = await owner.application.execute(sql`select current_user as name,rolsuper,rolbypassrls
    from pg_roles where rolname=current_user`);
  assert.equal(role[0]?.name, 'neuton_app');
  assert.equal(role[0]?.rolsuper, false);
  assert.equal(role[0]?.rolbypassrls, false);
  await owner.admin.insert(shopMembers).values({ shopId: owner.shopId, userId: member.userId, role: 'member' });
  for (const fixture of [owner, other]) {
    await fixture.inShop(async ({ database, shopId }) => {
      await database.insert(inventoryItems).values({ shopId, name: 'RLS fixture',
        rawMaterialName: 'RLS fixture', unit: 'g', baseUnit: 'g', baseUnitAmount: '1', baseUnitCost: '0' });
      await database.insert(mediaUploads).values({ shopId, uploadedBy: fixture.userId, kind: 'receipt',
        sources: [{ sourceId: 'fixture', storagePath: `${shopId}/fixture.png`, contentType: 'image/png',
          originalFilename: null, byteSize: 1 }] });
    });
  }
  await owner.inShop(async ({ database }) => {
    assert.equal((await database.select().from(profiles)).length, 1, 'profile reads remain self-only');
    assert.equal((await database.select().from(shopMembers)).length, 1, 'membership projection remains self-only');
    assert.equal((await database.select().from(inventoryItems)).length, 1, 'foreign inventory is hidden');
    assert.equal((await database.select().from(mediaUploads)).length, 1, 'foreign uploads are hidden');
  });
  await assert.rejects(withShopTransaction(owner.application, owner.actor.session, other.shopId, async () => {}),
    { statusCode: 403 });
  await assert.rejects(withShopTransaction(other.application, other.actor.session, owner.shopId, async () => {}),
    { statusCode: 403 });
  await assert.rejects(owner.inShop(async ({ database }) => {
    await database.insert(inventoryItems).values({ shopId: other.shopId, name: 'Forbidden',
      rawMaterialName: 'Forbidden', unit: 'g', baseUnit: 'g', baseUnitAmount: '1', baseUnitCost: '0' });
  }), error => databaseCode(error) === '42501');
  await withShopTransaction(member.application, member.actor.session, owner.shopId, async ({ database }) => {
    assert.equal((await database.select().from(inventoryItems)).length, 1, 'members can read their shop');
  });
  await assert.rejects(withShopTransaction(member.application, member.actor.session, owner.shopId, async ({ database }) => {
    await database.insert(inventoryItems).values({ shopId: owner.shopId, name: 'Forbidden member edit',
      rawMaterialName: 'Forbidden', unit: 'g', baseUnit: 'g', baseUnitAmount: '1', baseUnitCost: '0' });
  }), error => databaseCode(error) === '42501');
  await assert.rejects(owner.application.execute(sql`select id from auth_private.users`),
    error => databaseCode(error) === '42501');
  await assert.rejects(owner.inShop(({ database }) => database.execute(sql`update public.media_uploads set sources='[]'::jsonb`)),
    error => databaseCode(error) === '23514');
  assert.equal((await owner.application.select().from(inventoryItems)).length, 0, 'shop scope cannot leak after a transaction');
  console.log(`Neon RLS verification passed: ${tenantTables.length} forced tenant tables, restricted app role, scoped reads/writes and immutable sources.`);
} catch (error) {
  console.error('Neon RLS verification failed:', error instanceof assert.AssertionError ? error.message : 'Database or authorization check failed');
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(fixtures.reverse().map(fixture => fixture.close()));
  if (cleanup.some(result => result.status === 'rejected')) {
    console.error('Neon RLS fixture cleanup failed');
    process.exitCode = 1;
  }
}

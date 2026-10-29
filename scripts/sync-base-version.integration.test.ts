import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test(
  'base revisions prevent future client timestamps from overwriting intervening edits and preserve replay',
  {
    skip:
      !process.env.SYNC_TEST_DATABASE_URL &&
      'Requires a migrated disposable SYNC_TEST_DATABASE_URL',
    timeout: 20000,
  },
  async () => {
    process.env.DATABASE_URL = process.env.SYNC_TEST_DATABASE_URL;
    const [{ db, sql: connection }, { sql }, { buildSyncApplication }] =
      await Promise.all([
        import('../src/db/client.js'),
        import('drizzle-orm'),
        import('./support/syncApp.js'),
      ]);
    const shopId = randomUUID(),
      userId = randomUUID(),
      recipeId = randomUUID();
    const fixture = await buildSyncApplication(
      db,
      {
        id: shopId,
        name: 'Base fixture',
        slug: shopId,
        currency: 'USD',
        timezone: 'UTC',
        storeAddress: null,
        targetProfitMargin: '30',
        hourlyLaborCost: '25',
        deliveryBaseFee: '5',
        deliveryRatePerKm: '1',
      },
      userId,
    );
    try {
      await db.execute(
        sql`insert into auth.users(id,email) values (${userId}::uuid,'base@example.test')`,
      );
      await db.execute(sql`insert into profiles(id) values (${userId}::uuid)`);
      await db.execute(
        sql`insert into shops(id,name,slug) values (${shopId}::uuid,'Base fixture',${shopId})`,
      );
      await db.execute(
        sql`insert into recipes(id,shop_id,name,status) values (${recipeId}::uuid,${shopId}::uuid,'Original','unverified')`,
      );
      const versions = await db.execute(
        sql`select updated_at from document_versions where shop_id=${shopId}::uuid and id=${recipeId}::uuid`,
      );
      const base = Number(versions[0]!.updated_at);
      const mutationId = randomUUID();
      const patch = (
        name: string,
        version: number,
        expected: number,
        id = randomUUID(),
      ) =>
        fixture.inject({
          method: 'PATCH',
          url: `/api/v1/recipes/${recipeId}`,
          headers: {
            authorization: 'Bearer test-session',
            'x-shop-id': shopId,
            'x-sync-id': id,
            'x-sync-version': String(version),
            'x-sync-base-version': String(expected),
          },
          payload: { name },
        });
      const first = await patch('First edit', base + 100, base, mutationId);
      assert.equal(first.statusCode, 200);
    const snapshot = await fixture.inject({ method: 'GET', url: `/api/v1/recipes/${recipeId}`, headers: {
      authorization: 'Bearer test-session', 'x-shop-id': shopId, 'x-sync-snapshot': 'true',
    } });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().syncVersion, base + 100);
    assert.equal(snapshot.json().recipe.name, 'First edit');
      const stale = await patch('Stale edit', base + 10000, base);
      assert.equal(stale.json().syncConflict, true);
      assert.equal(
        (
          await db.execute(
            sql`select name from recipes where id=${recipeId}::uuid`,
          )
        )[0]?.name,
        'First edit',
      );
      assert.deepEqual(
        (await patch('First edit', base + 100, base, mutationId)).json(),
        first.json(),
      );
      assert.equal(
        (await patch('First edit', base + 100, base + 1, mutationId))
          .statusCode,
        409,
      );
    } finally {
      await fixture.close();
      await db.execute(sql`delete from shops where id=${shopId}::uuid`);
      await db.execute(sql`delete from auth.users where id=${userId}::uuid`);
      await connection.end({ timeout: 2 });
    }
  },
);

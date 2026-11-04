import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { buildSyncApplication } from './support/syncApp.js';

test(
  'base revisions prevent future client timestamps from overwriting intervening edits and preserve replay',
  {
    skip: neonTestSkip,
    timeout: 60000,
  },
  async () => {
    const f = await neonFixture();
    const { admin: db, shopId, userId } = f;
    const recipeId = randomUUID();
    let fixture: Awaited<ReturnType<typeof buildSyncApplication>> | undefined;
    try {
      const client = await buildSyncApplication(f.application, f.shop, userId, 'owner',
        { id: f.sessionId, secret: f.secret });
      fixture = client;
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
        client.inject({
          method: 'PATCH',
          url: `/api/v1/recipes/${recipeId}`,
          headers: {
            cookie: `neuton-dev-session=${f.secret}`,
            'x-shop-id': shopId,
            'x-sync-id': id,
            'x-sync-version': String(version),
            'x-sync-base-version': String(expected),
          },
          payload: { name },
        });
      const first = await patch('First edit', base + 100, base, mutationId);
      assert.equal(first.statusCode, 200);
    const snapshot = await client.inject({ method: 'GET', url: `/api/v1/recipes/${recipeId}`, headers: {
      cookie: `neuton-dev-session=${f.secret}`, 'x-shop-id': shopId, 'x-sync-snapshot': 'true',
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
      try { await fixture?.close(); } finally { await f.close(); }
    }
  },
);

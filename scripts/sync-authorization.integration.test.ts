import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { processingDatabase } from './support/processingDatabase.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../src/modules/shops/contracts.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import { RecipePersistence } from '../src/modules/recipes/recipe.persistence.js';
import { SyncService } from '../src/modules/sync/sync.service.js';
import { SyncPersistence } from '../src/modules/sync/sync.persistence.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { withUserTransaction } from '../src/db/tenant-context.js';
import { sql } from 'drizzle-orm';
import { recipes } from '../src/db/schema/index.js';

test('sync reads, snapshots, tombstones and replay stay within the selected shop and originating user', async () => {
  const { database, application, actor, auth } = await processingDatabase();
  try {
    const otherShop = await new ShopsPersistence(application).create(actor, createShopSchema.parse({ name: 'Other Kitchen' }));
    const ownId = randomUUID(), otherId = randomUUID();
    await database.query('insert into public.recipes(id,shop_id,name) values($1,$2,$3),($4,$5,$6)',
      [ownId, actor.shop.id, 'Scoped recipe', otherId, otherShop.id, 'Foreign recipe']);
    const persistence = new SyncPersistence(application);
    const sync = new SyncService(persistence);
    const comparison = await sync.check(actor, []);
    assert.deepEqual(comparison.toPull.map(row => row.id), [ownId]);
    const recipeService = new RecipeService(new RecipePersistence(application));
    const snapshot = await sync.snapshot(actor, 'recipe', ownId, scope => {
      assert.equal(scope.shopId, actor.shop.id);
      return recipeService.inTransaction(scope, () => {}).recipe(actor, ownId);
    });
    assert.equal(snapshot.recipe.id, ownId); assert.ok(snapshot.syncVersion > 0);
    await assert.rejects(sync.snapshot(actor, 'recipe', otherId, scope =>
      recipeService.inTransaction(scope, () => {}).recipe(actor, otherId)), { statusCode: 404 });
    assert.deepEqual(await withUserTransaction(application, actor.session, scope =>
      scope.database.select().from(recipes)), []);

    const mutation = { mutationId: randomUUID(), kind: 'recipe' as const, documentId: ownId,
      version: snapshot.syncVersion + 10000, baseVersion: snapshot.syncVersion,
      method: 'PATCH', path: `/recipes/${ownId}`, body: { name: 'Renamed' }, status: 200 };
    const result = await sync.mutate(actor, mutation, async (scope, afterCommit) => {
      assert.ok(scope); assert.ok(afterCommit);
      return recipeService.inTransaction(scope, afterCommit).editRecipe(actor, ownId, { name: 'Renamed' });
    });
    assert.deepEqual(await sync.mutate(actor, mutation, async () => assert.fail('Replay must not mutate')), result);

    const accounts = new AccountRepository(auth), sessions = new SessionRepository(auth);
    const userId = await auth.transaction(async tx => {
      const account = await accounts.createPending(tx, { email: 'another-sync@example.com', fullName: 'Another member' });
      assert.ok(account); return account.user.id;
    });
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [userId]);
    await database.query("insert into public.shop_members(shop_id,user_id,role) values($1,$2,'admin')", [actor.shop.id, userId]);
    const issued = await auth.withUser(userId, account => sessions.issue(account, { method: 'password' }, {}));
    assert.ok(issued);
    const resolved = await sessions.resolve(issued.secret); assert.ok(resolved);
    const another = { ...actor, user: { ...actor.user, id: userId, email: resolved.email },
      session: resolved.reference, sessionId: resolved.id, role: 'admin' as const };
    const secondMutation = { ...mutation, documentId: null, version: mutation.version + 10000 };
    const leakedReplay = await sync.mutate(another, mutation, async () => ({ mustNotLeak: true }));
    // A changed document base version returns a conflict without returning the
    // other user's cached response. A creation replay collision rolls back.
    assert.deepEqual(leakedReplay.body, { syncConflict: true });
    await assert.rejects(sync.mutate(another, secondMutation, async scope => {
      assert.ok(scope);
      await scope.database.execute(sql`update public.recipes set name='Must roll back' where id=${ownId}::uuid`);
      return { mustNotLeak: true };
    }), { statusCode: 409 });
    assert.equal((await recipeService.recipe(actor, ownId)).recipe.name, 'Renamed');
    await database.query('delete from public.recipes where id=$1', [ownId]);
    const tombstones = await sync.check(actor, []);
    assert.equal(tombstones.toPull[0]!.id, ownId); assert.equal(tombstones.toPull[0]!.deleted, true);
    await database.query('delete from public.shop_members where shop_id=$1 and user_id=$2', [actor.shop.id, actor.user.id]);
    await assert.rejects(sync.check(actor, []), { statusCode: 403 });
    await assert.rejects(sync.mutate(actor, mutation, async () => assert.fail('Revoked replay must not execute')), { statusCode: 403 });
  } finally { await database.close(); }
});

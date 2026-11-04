import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../src/modules/shops/contracts.js';
import { CategoriesPersistence } from '../src/modules/categories/categories.persistence.js';
import { CategoriesService } from '../src/modules/categories/categories.service.js';
import { InventoryPersistence } from '../src/modules/inventory/inventory.persistence.js';
import { InventoryService } from '../src/modules/inventory/inventory.service.js';
import { inventorySchema } from '../src/modules/inventory/contracts.js';
import { DomainAudit } from '../src/lib/domainAudit.js';
import type { Database } from '../src/db/client.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { apiLogger } from '../src/lib/logger/index.js';
import { RecipePersistence } from '../src/modules/recipes/recipe.persistence.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import { recipeSchema } from '../src/modules/recipes/contracts.js';
import { OrdersPersistence } from '../src/modules/orders/orders.persistence.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { OrdersAudit } from '../src/modules/orders/orders.audit.js';
import { createOrderSchema } from '../src/modules/orders/contracts.js';
import { ReceiptsPersistence } from '../src/modules/receipts/receipts.persistence.js';
import { ReceiptsService } from '../src/modules/receipts/receipts.service.js';
import { AnalyticsPersistence } from '../src/modules/analytics/analytics.persistence.js';
import { AnalyticsService } from '../src/modules/analytics/analytics.service.js';
import { UploadsPersistence } from '../src/modules/uploads/uploads.persistence.js';
import { UploadsService } from '../src/modules/uploads/uploads.service.js';
import { randomUUID } from 'node:crypto';
import { priceResult } from './support/priceResult.js';
import { SyncPersistence } from '../src/modules/sync/sync.persistence.js';
import { SyncService } from '../src/modules/sync/sync.service.js';

test('business services enforce live membership, atomic audit and rollback under the app role', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const sessions = new SessionRepository(auth);
    const userId = await auth.transaction(async tx => {
      const account = await accounts.createPending(tx, { email: 'business@example.com', fullName: 'Owner' });
      assert.ok(account); return account.user.id;
    });
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [userId]);
    const issued = await auth.withUser(userId, account => sessions.issue(account, { method: 'password' }, {}));
    assert.ok(issued);
    const resolved = await sessions.resolve(issued.secret);
    assert.ok(resolved);
    type Tx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
    let activeTransactions = 0;
    const application = {
      transaction<T>(work: (tx: Tx) => Promise<T>) {
        return orm.transaction(async tx => {
          await tx.execute(sql`set local role neuton_app`);
          activeTransactions += 1;
          try { return await work(tx); } finally { activeTransactions -= 1; }
        });
      }
    } as unknown as Database;
    const sessionActor = {
      session: resolved.reference, sessionId: resolved.id,
      user: { id: userId, email: resolved.email, fullName: 'Owner', avatarUrl: null },
      log: apiLogger, traceId: 'business', requestId: 'business'
    };
    const shop = await new ShopsPersistence(application).create(sessionActor, createShopSchema.parse({ name: 'Scoped Kitchen' }));
    const actor = { ...sessionActor, shop, role: 'owner' } as ActorContext;
    const categories = new CategoriesService(new CategoriesPersistence(application));
    const category = await categories.createCategory(actor, { name: 'Flour' });
    assert.equal((await categories.categories(actor)).categories[0]?.id, category.category.id);
    const inventory = new InventoryService(new InventoryPersistence(application));
    const input = inventorySchema.parse({
      name: 'Flour', rawMaterialName: 'Flour', unit: 'kg',
      baseUnit: 'g', baseUnitAmount: 1000, baseUnitCost: 0.002, currentQuantity: 2
    });
    const item = await inventory.createInventory(actor, input);
    assert.equal(item.item.shopId, shop.id);
    const audit = await database.query<{ user_id: string }>("select user_id from public.audit_logs where event_type='INVENTORY_UPDATED'");
    assert.equal(audit.rows[0]?.user_id, userId);
    class RejectAudit extends DomainAudit { override async record() { throw new Error('synthetic audit failure'); } }
    const rejecting = new InventoryService(new InventoryPersistence(application), new RejectAudit());
    await assert.rejects(rejecting.createInventory(actor, { ...input, name: 'Rolled back' }), /synthetic audit failure/);
    assert.equal((await database.query("select id from public.inventory_items where name='Rolled back'")).rows.length, 0);
    const recipes = new RecipeService(new RecipePersistence(application));
    const created = await recipes.createRecipe(actor, recipeSchema.parse({
      name: 'Bread', ingredients: [{
        rawName: 'Flour', rawMaterialName: 'Flour', quantity: 100, rawSrcUnit: 'g',
        baseUnit: 'g', baseUnitAmount: 100, inventoryItemId: item.item.id,
      }]
    }));
    const manual = await recipes.manualProduct(actor, created.recipe.id, {
      name: 'Milk', rawMaterialName: 'Milk',
      price: 4, packageSize: 1, packageUnit: 'l', quantity: 100, rawSrcUnit: 'ml'
    });
    assert.ok(manual.product.id);
    await recipes.verifyRecipe(actor, created.recipe.id, {});
    assert.equal((await recipes.recipe(actor, created.recipe.id)).recipe.costing.costComplete, true);
    const sync = new SyncService(new SyncPersistence(application));
    const version = async () => Number((await database.query<{ updated_at: string }>(
      "select updated_at from public.document_versions where shop_id=$1 and kind='recipe' and id=$2", [shop.id, created.recipe.id])).rows[0]?.updated_at);
    const baseVersion = await version();
    const mutation = {
      mutationId: randomUUID(), kind: 'recipe' as const, documentId: created.recipe.id,
      version: baseVersion + 1000, baseVersion, path: `/recipes/${created.recipe.id}`, method: 'PATCH',
      body: { name: 'Synchronized bread' }, status: 200
    };
    const synchronized = await sync.mutate(actor, mutation, async (scope, afterCommit) => {
      assert.ok(scope); assert.ok(afterCommit);
      return recipes.inTransaction(scope, afterCommit).editRecipe(actor, created.recipe.id, { name: 'Synchronized bread' });
    });
    assert.deepEqual(await sync.mutate(actor, mutation, async () => { assert.fail('Replay must not run the mutation again'); }), synchronized);
    const rolledBackId = randomUUID();
    await assert.rejects(sync.mutate(actor, { ...mutation, mutationId: rolledBackId, baseVersion: await version(), version: baseVersion + 2000 }, async (scope, afterCommit) => {
      assert.ok(scope); assert.ok(afterCommit);
      await recipes.inTransaction(scope, afterCommit).editRecipe(actor, created.recipe.id, { name: 'Must roll back' });
      throw new Error('synthetic outer rollback');
    }), /synthetic outer rollback/);
    assert.equal((await database.query('select id from public.document_mutations where id=$1', [rolledBackId])).rows.length, 0);
    assert.equal((await recipes.recipe(actor, created.recipe.id)).recipe.name, 'Synchronized bread');
    const orders = new OrdersService(new OrdersPersistence(application), new OrdersAudit());
    await database.query("update public.shop_members set role='member' where shop_id=$1 and user_id=$2", [shop.id, userId]);
    const memberActor = { ...actor, role: 'member' as const };
    const memberInput = createOrderSchema.parse({ items: [{ recipeId: created.recipe.id, quantity: 1 }] });
    const memberMutation = { mutationId: randomUUID(), kind: 'order' as const, documentId: null,
      version: Date.now(), method: 'POST', path: '/orders', body: memberInput, status: 201,
      allowedRoles: ['owner', 'admin', 'member'] as const };
    const memberOrder = await sync.mutate(memberActor, memberMutation, async (scope, afterCommit) => {
      assert.ok(scope); assert.ok(afterCommit);
      return orders.inTransaction(scope, afterCommit).create(memberActor, memberInput);
    });
    const memberCreated = memberOrder.body as Awaited<ReturnType<typeof orders.create>>;
    assert.equal(memberCreated.order.orderNumber, 1);
    assert.equal(memberCreated.order.userId, userId);
    await new OrdersPersistence(application).inShop(memberActor, async persistence => {
      await persistence.database.execute(sql`update public.orders set customer_name='Forbidden edit' where id=${memberCreated.order.id}::uuid`);
      await persistence.database.execute(sql`delete from public.orders where id=${memberCreated.order.id}::uuid`);
    });
    const unchangedMemberOrder = (await orders.detail(memberActor, memberCreated.order.id)).order;
    assert.equal(unchangedMemberOrder.customerName, null);
    assert.equal(unchangedMemberOrder.status, 'processing');
    await orders.verify(memberActor, memberCreated.order.id);
    await assert.rejects(orders.cancel(memberActor, memberCreated.order.id), { statusCode: 403 });
    assert.deepEqual(await sync.mutate(memberActor, memberMutation, async () => { assert.fail('Member retry must replay'); }), memberOrder);
    await database.query("update public.shop_members set role='owner' where shop_id=$1 and user_id=$2", [shop.id, userId]);
    const order = await orders.create(actor, createOrderSchema.parse({ items: [{ recipeId: created.recipe.id, quantity: 1 }] }));
    assert.equal(order.order.orderNumber, 2);
    await orders.verify(actor, order.order.id);
    await orders.cancel(actor, order.order.id);
    const linkedUploadId = randomUUID();
    const linkedPath = `${shop.id}/recipes/history.jpg`;
    await database.query(`insert into public.media_uploads(id,shop_id,uploaded_by,kind,recipe_id,sources)
      values($1,$2,$3,'recipe',$4,$5::jsonb)`, [linkedUploadId, shop.id, userId, created.recipe.id,
      JSON.stringify([{ sourceId: randomUUID(), storagePath: linkedPath, contentType: 'image/jpeg', byteSize: 20, originalFilename: null }])]);
    await new RecipePersistence(application).inShop(actor, async persistence => {
      await persistence.database.execute(sql`delete from public.media_uploads where id=${linkedUploadId}::uuid`);
    });
    assert.equal((await database.query('select id from public.media_uploads where id=$1', [linkedUploadId])).rows.length, 1, 'active recipe upload cannot be directly deleted');
    const deleted = await recipes.deleteRecipe(actor, created.recipe.id);
    assert.equal(deleted.mode, 'soft', 'historical order lines keep their recipe reference');
    assert.equal((await database.query('select id from public.media_uploads where id=$1', [linkedUploadId])).rows.length, 0);
    assert.equal((await database.query('select id from public.storage_object_deletions where storage_path=$1', [linkedPath])).rows.length, 1);
    const unreferenced = await recipes.createRecipe(actor, recipeSchema.parse({ name: 'Disposable bread', ingredients: [{ rawName: 'Flour', quantity: 1, rawSrcUnit: 'g' }] }));
    assert.equal((await recipes.deleteRecipe(actor, unreferenced.recipe.id)).mode, 'hard');
    const receipts = new ReceiptsService(new ReceiptsPersistence(application));
    const receiptId = randomUUID();
    const lineId = randomUUID();
    await database.query("insert into public.receipts(id,shop_id,status,storage_path) values($1,$2,'unverified',$3)", [receiptId, shop.id, `${shop.id}/purchase.jpg`]);
    await database.query(`insert into public.receipt_items(id,shop_id,receipt_id,raw_name,raw_material_name,quantity,unit_price,src_unit,base_unit,base_unit_amount)
      values($1,$2,$3,'Flour','Flour',1,2,'kg','g',1000)`, [lineId, shop.id, receiptId]);
    await receipts.edit(actor, receiptId, { merchantName: 'Merchant' });
    await receipts.verify(actor, receiptId, { items: [{ id: lineId, accepted: true }] });
    await assert.rejects(receipts.verify(actor, receiptId, { items: [{ id: lineId, accepted: true }] }), { statusCode: 409 });
    const analytics = new AnalyticsService(new AnalyticsPersistence({ db: application, now: () => new Date() }));
    assert.ok(await analytics.dashboard(actor, '30d'));
    const uploads = new UploadsService(new UploadsPersistence({
      db: application,
      createPresignedUploadUrl: async path => { assert.equal(activeTransactions, 0); return `https://upload.test/${path}`; },
      createPresignedDownloadUrl: async path => { assert.equal(activeTransactions, 0); return `https://download.test/${path}`; },
      getObjectMetadata: async () => { assert.equal(activeTransactions, 0); return { byteSize: 20, contentType: 'image/jpeg' }; },
      enqueueMediaJob: async () => { assert.equal(activeTransactions, 0); return { queued: true, jobId: 'synthetic' }; },
    }));
    const upload = await uploads.presign(actor, { kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 20 }] });
    assert.ok(upload.receiptId);
    assert.equal((await uploads.complete(actor, { uploadId: upload.uploadId })).queued, true);
    assert.ok((await uploads.download(actor, upload.sources[0]!.storagePath)).url);
    await assert.rejects(uploads.download(actor, `${shop.id}/unknown.jpg`), { statusCode: 404 });
    const pendingUpload = await uploads.presign(actor, { kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 20 }] });
    let queuedAfterRevocation = false;
    const revokingUpload = new UploadsService(new UploadsPersistence({
      db: application,
      createPresignedUploadUrl: async () => 'unused', createPresignedDownloadUrl: async () => 'unused',
      getObjectMetadata: async () => {
        assert.equal(activeTransactions, 0);
        await database.query("update public.shop_members set role='member' where shop_id=$1 and user_id=$2", [shop.id, userId]);
        return { byteSize: 20, contentType: 'image/jpeg' };
      },
      enqueueMediaJob: async () => { queuedAfterRevocation = true; return { queued: true, jobId: 'forbidden' }; },
    }));
    await assert.rejects(revokingUpload.complete(actor, { uploadId: pendingUpload.uploadId }), { statusCode: 403 });
    assert.equal(queuedAfterRevocation, false);
    assert.equal((await database.query<{ queued_at: Date | null }>('select queued_at from public.media_uploads where id=$1', [pendingUpload.uploadId])).rows[0]?.queued_at, null);
    await database.query("update public.shop_members set role='owner' where shop_id=$1 and user_id=$2", [shop.id, userId]);
    const lookupRecipe = await recipes.createRecipe(actor, recipeSchema.parse({ name: 'Lookup', ingredients: [{ rawName: 'Milk', quantity: 1, rawSrcUnit: 'ml' }] }));
    const revokingSearch = new RecipeService(new RecipePersistence(application), new DomainAudit(), undefined, async () => {
      assert.equal(activeTransactions, 0);
      await database.query("update public.shop_members set role='member' where shop_id=$1 and user_id=$2", [shop.id, userId]);
      return [priceResult({ itemCode: '7290000000001', itemName: 'Forbidden price', unitQty: 'l', quantity: '1', itemPrice: '6' })];
    });
    await assert.rejects(revokingSearch.barcodePrice(actor, lookupRecipe.recipe.id, {
      barcode: '7290000000001', rawMaterialName: 'Milk', quantity: 1, rawSrcUnit: 'ml',
    }), { statusCode: 403 });
    assert.equal((await database.query("select id from public.general_prices where raw_name='Forbidden price'")).rows.length, 0);
    await database.query("update public.shop_members set role='member' where shop_id=$1 and user_id=$2", [shop.id, userId]);
    await assert.rejects(inventory.createInventory(actor, { ...input, name: 'Forbidden' }), { statusCode: 403 });
    assert.equal((await inventory.inventory(actor, { includeInactive: false, lowStockOnly: false })).items.length, 1);
    await database.query('delete from public.shop_members where shop_id=$1 and user_id=$2', [shop.id, userId]);
    await assert.rejects(categories.categories(actor), { statusCode: 403 });
  } finally { await database.close(); }
});

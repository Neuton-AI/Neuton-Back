import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Explicit opt-in prevents this suite from applying fixtures to a configured production database.
test(
  'sync retries, conflicts, tombstones and order create completion preserve commit and rollback effects',
  {
    timeout: 60_000,
    skip:
      !process.env.SYNC_TEST_DATABASE_URL &&
      'Set SYNC_TEST_DATABASE_URL to a migrated disposable database',
  },
  async () => {
    process.env.DATABASE_URL = process.env.SYNC_TEST_DATABASE_URL;
    const [
      { default: Fastify },
      { db, sql: connection },
      { sql },
      { registerDocumentSync },
      { catalogRoutes },
      { receiptRoutes },
      { orderRoutes },
      { registerErrorHandler },
    ] = await Promise.all([
      import('fastify'),
      import('../src/db/client.js'),
      import('drizzle-orm'),
      import('../src/plugins/documentSync.js'),
      import('../src/routes/catalog.js'),
      import('../src/routes/receipts.js'),
      import('../src/routes/orders.js'),
      import('../src/lib/errorHandler.js'),
    ]);
    const shopId = randomUUID();
    const userId = randomUUID();
    const recipeId = randomUUID();
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorate('authenticate', async (request) => {
      if (request.headers.authorization !== 'Bearer test-session')
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      request.user = {
        id: userId,
        email: 'sync@example.com',
        fullName: null,
        avatarUrl: null,
      };
    });
    app.decorate('resolveShop', async (request) => {
      if (request.headers['x-shop-id'] !== shopId)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      request.shop = {
        id: shopId,
        name: 'Sync fixture',
        slug: shopId,
        currency: 'USD',
        timezone: 'UTC',
        storeAddress: null,
        targetProfitMargin: '30',
        hourlyLaborCost: '25',
        deliveryBaseFee: '5',
        deliveryRatePerKm: '1',
      };
      request.shopRole = 'owner';
    });
    app.decorate('requireRole', () => async () => {});
    registerDocumentSync(app);
    await app.register(catalogRoutes, { prefix: '/api/v1' });
    await app.register(receiptRoutes, { prefix: '/api/v1' });
    await app.register(orderRoutes, { prefix: '/api/v1' });
    await app.ready();
    try {
      await db.execute(
        sql`insert into auth.users(id,email) values (${userId}::uuid,'sync@example.com')`,
      );
      await db.execute(
        sql`insert into profiles(id) values (${userId}::uuid) on conflict do nothing`,
      );
      await db.execute(
        sql`insert into shops(id,name,slug) values (${shopId}::uuid,'Sync fixture',${shopId})`,
      );
      await db.execute(
        sql`insert into recipes(id,shop_id,name,status) values (${recipeId}::uuid,${shopId}::uuid,'Original','unverified')`,
      );
      const headers = {
        authorization: 'Bearer test-session',
        'x-shop-id': shopId,
      };
      const check = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/sync/check',
          headers,
          payload: { documents: [] },
        });
      const first = (await check()).json().toPull.find((document: { id: string }) => document.id === recipeId);
      assert.equal(first.id, recipeId);
      const version = first.updatedAt + 100;
      const mutationId = randomUUID();
      const patch = (name: string, updatedAt: number, id = randomUUID()) =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/recipes/${recipeId}`,
          headers: {
            ...headers,
            'x-sync-id': id,
            'x-sync-version': String(updatedAt),
          },
          payload: {
            name,
            ...(name === 'First edit'
              ? {
                  ingredients: [
                    {
                      rawName: 'Flour',
                      rawMaterialName: 'Flour',
                      quantity: 1,
                      rawSrcUnit: 'g',
                    },
                  ],
                }
              : {}),
          },
        });
      const pushed = await patch('First edit', version, mutationId);
      assert.equal(pushed.statusCode, 200, pushed.body);
      assert.equal(pushed.json().recipe.name, 'First edit');
      assert.equal((await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt, version);
      assert.deepEqual(
        (await patch('First edit', version, mutationId)).json(),
        pushed.json(),
      );
      assert.equal(
        (await patch('Different request', version, mutationId)).statusCode,
        409,
      );
      assert.equal((await patch('Newer edit', version + 100)).statusCode, 200);
      assert.equal(
        (await patch('Delayed older client', version + 50)).json().syncConflict,
        true,
      );
      const row = await db.execute(
        sql`select name from recipes where id=${recipeId}::uuid`,
      );
      assert.equal(row[0]?.name, 'Newer edit');
      const equal = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/check',
        headers,
        payload: {
          documents: [
            { kind: 'recipe', id: recipeId, updatedAt: version + 100 },
          ],
        },
      });
      assert.deepEqual(equal.json(), { toPush: [], toPull: [] });
      const invalid = await patch('', version + 200);
      assert.equal(invalid.statusCode, 400);
      assert.equal((await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt, version + 100);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/sync/check',
            payload: { documents: [] },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/sync/check',
            headers: { ...headers, 'x-shop-id': randomUUID() },
            payload: { documents: [] },
          })
        ).statusCode,
        403,
      );
      const inventoryId = randomUUID();
      await db.execute(sql`insert into inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost)
        values (${inventoryId}::uuid,${shopId}::uuid,'Flour','Flour','kg','g',1000,0.002)`);
      await db.execute(
        sql`update recipe_ingredients set inventory_item_id=${inventoryId}::uuid where recipe_id=${recipeId}::uuid`,
      );
      const beforeCostChange = (await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt;
      await db.execute(
        sql`update inventory_items set base_unit_cost=0.003 where id=${inventoryId}::uuid`,
      );
      assert.ok((await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt > beforeCostChange);
      const beforeShopChange = (await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt;
      await db.execute(
        sql`update shops set target_profit_margin=35 where id=${shopId}::uuid`,
      );
      // A failure saving the sync retry receipt must roll back the domain
      // mutation without publishing a successful order audit.
      const orderRecipeId = randomUUID();
      await db.execute(sql`insert into recipes(id,shop_id,name,status)
        values (${orderRecipeId}::uuid,${shopId}::uuid,'Order fixture','unverified')`);
      await db.execute(sql`insert into recipe_ingredients(shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,quantity,raw_src_unit,base_unit,base_unit_amount)
        values (${shopId}::uuid,${orderRecipeId}::uuid,${inventoryId}::uuid,'Flour','Flour',1,'g','g',1)`);
      const rejectedMutation = randomUUID();
      const constraintName = `sync_order_rollback_${shopId.replaceAll('-', '')}`;
      const orderPayload = { items: [{ recipeId: orderRecipeId, quantity: 1 }] };
      const orderVersion = Date.now() + 100_000;
      const mutateOrder = (method: 'POST' | 'DELETE', path: string, mutation: string, version: number) =>
        app.inject({ method, url: `/api/v1/orders${path}`, headers: {
          ...headers, 'x-sync-id': mutation, 'x-sync-version': String(version),
        }, ...(path === '' ? { payload: orderPayload } : {}) });
      const audits = () => db.execute(sql`select event_type from audit_logs
        where shop_id=${shopId}::uuid and event_type like 'ORDER_%' order by created_at`);
      const rejectReceipt = async (mutate: () => ReturnType<typeof mutateOrder>) => {
        await db.execute(sql`alter table document_mutations add constraint ${sql.identifier(constraintName)}
          check (id <> ${sql.raw(`'${rejectedMutation}'`)}::uuid) not valid`);
        try {
          const failed = await mutate();
          assert.equal(failed.statusCode, 500, failed.body);
        } finally {
          await db.execute(sql`alter table document_mutations drop constraint ${sql.identifier(constraintName)}`);
        }
      };
      const beforeRecipeRollback = (await check()).json().toPull.find((document: { id: string }) => document.id === recipeId);
      const recipeAudits = () => db.execute(sql`select count(*)::int as count from audit_logs
        where shop_id=${shopId}::uuid and resource_id=${recipeId}::uuid and event_type='RECIPE_UPDATED'`);
      const auditCountBefore = (await recipeAudits())[0]?.count;
      const nameBefore = (await db.execute(sql`select name from recipes where id=${recipeId}::uuid`))[0]?.name;
      await rejectReceipt(() => app.inject({ method: 'PATCH', url: `/api/v1/recipes/${recipeId}`, headers: {
        ...headers, 'x-sync-id': rejectedMutation, 'x-sync-version': String(beforeRecipeRollback.updatedAt + 100),
      }, payload: { name: 'Must roll back' } }));
      assert.equal((await db.execute(sql`select name from recipes where id=${recipeId}::uuid`))[0]?.name, nameBefore);
      assert.equal((await recipeAudits())[0]?.count, auditCountBefore, 'rolled-back recipe edit emits no audit');
      const ingredientsBefore = [...await db.execute(sql`select id,raw_name,quantity,base_unit_amount
        from recipe_ingredients where recipe_id=${recipeId}::uuid order by id`)];
      await rejectReceipt(() => app.inject({ method: 'POST', url: `/api/v1/recipes/${recipeId}/verify`, headers: {
        ...headers, 'x-sync-id': rejectedMutation, 'x-sync-version': String(beforeRecipeRollback.updatedAt + 100),
      }, payload: { ingredients: [{ rawName: 'Must roll back', quantity: 2, rawSrcUnit: 'kg', baseUnit: 'g', baseUnitAmount: 2000 }] } }));
      assert.equal((await db.execute(sql`select status from recipes where id=${recipeId}::uuid`))[0]?.status, 'unverified');
      assert.deepEqual([...await db.execute(sql`select id,raw_name,quantity,base_unit_amount
        from recipe_ingredients where recipe_id=${recipeId}::uuid order by id`)], ingredientsBefore);
      assert.equal((await recipeAudits())[0]?.count, auditCountBefore, 'rolled-back verification emits no audit');
      await rejectReceipt(() => mutateOrder('POST', '', rejectedMutation, orderVersion));
      assert.equal((await db.execute(sql`select count(*)::int as count from orders where shop_id=${shopId}::uuid`))[0]?.count, 0);
      assert.equal((await db.execute(sql`select last_order_number from shops where id=${shopId}::uuid`))[0]?.last_order_number, 0);
      assert.equal((await audits()).length, 0);

      const createMutation = randomUUID();
      const created = await mutateOrder('POST', '', createMutation, orderVersion);
      assert.equal(created.statusCode, 201, created.body);
      const createdOrderId = created.json().order.id;
      assert.deepEqual((await mutateOrder('POST', '', createMutation, orderVersion)).json(), created.json());
      assert.deepEqual((await audits()).map(row => row.event_type), ['ORDER_CREATED']);
      const orderState = () => db.execute(sql`select status from orders where id=${createdOrderId}::uuid`);

      await rejectReceipt(() => mutateOrder('POST', `/${createdOrderId}/verify`, rejectedMutation, orderVersion + 100));
      assert.equal((await orderState())[0]?.status, 'processing');
      assert.deepEqual((await audits()).map(row => row.event_type), ['ORDER_CREATED']);
      const verifyMutation = randomUUID();
      const verified = await mutateOrder('POST', `/${createdOrderId}/verify`, verifyMutation, orderVersion + 100);
      assert.equal(verified.statusCode, 200, verified.body);
      assert.deepEqual((await mutateOrder('POST', `/${createdOrderId}/verify`, verifyMutation, orderVersion + 100)).json(), verified.json());
      assert.deepEqual((await audits()).map(row => row.event_type), ['ORDER_CREATED', 'ORDER_DELIVERED']);

      await rejectReceipt(() => mutateOrder('DELETE', `/${createdOrderId}`, rejectedMutation, orderVersion + 200));
      assert.equal((await orderState())[0]?.status, 'delivered');
      assert.deepEqual((await audits()).map(row => row.event_type), ['ORDER_CREATED', 'ORDER_DELIVERED']);
      const cancelMutation = randomUUID();
      const cancelled = await mutateOrder('DELETE', `/${createdOrderId}`, cancelMutation, orderVersion + 200);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.deepEqual((await mutateOrder('DELETE', `/${createdOrderId}`, cancelMutation, orderVersion + 200)).json(), cancelled.json());
      assert.deepEqual((await audits()).map(row => row.event_type), ['ORDER_CREATED', 'ORDER_DELIVERED', 'ORDER_CANCELLED']);

      const beforeDelete = (await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).updatedAt;
      assert.ok(beforeDelete > beforeShopChange);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/recipes/${recipeId}`,
        headers: {
          ...headers,
          'x-sync-id': randomUUID(),
          'x-sync-version': String(beforeDelete + 100),
        },
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal((await check()).json().toPull.find((document: { id: string }) => document.id === recipeId).deleted, true);
      assert.equal(
        (await patch('Resurrection', version + 400)).json().syncConflict,
        true,
      );
      const { presignDocument, completeDocument } =
        await import('../src/lib/mediaUploads.js');
      const uploadId = randomUUID();
      const services = {
        db,
        createPresignedUploadUrl: async () => 'https://storage.example/upload',
        getObjectMetadata: async () => ({
          byteSize: 4,
          contentType: 'image/png',
        }),
        enqueueMediaJob: async () => ({
          queued: true,
          jobId: `upload-${uploadId}`,
        }),
      };
      const uploadInput = {
        body: {
          clientRequestId: uploadId,
          kind: 'receipt',
          sources: [
            {
              originalFilename: 'local.png',
              contentType: 'image/png',
              byteSize: 4,
            },
          ],
        },
        shopId,
        userId,
        currency: 'USD',
      };
      const upload = await presignDocument(services, uploadInput);
      assert.equal(upload.receiptId, uploadId);
      assert.equal(
        (await presignDocument(services, uploadInput)).receiptId,
        uploadId,
      );
      const completion = { body: { uploadId }, shopId };
      assert.equal((await completeDocument(services, completion)).queued, true);
      assert.equal((await completeDocument(services, completion)).queued, true);
      const count = await db.execute(
        sql`select count(*)::int as count from receipts where id=${uploadId}::uuid`,
      );
      assert.equal(count[0]?.count, 1);
      const receiptVersion = (await check()).json().toPull.find((document: {id:string}) => document.id === uploadId).updatedAt;
      const cleanupCount = () => db.execute(sql`select count(*)::int as count from storage_object_deletions where shop_id=${shopId}::uuid`);
      const beforeCleanup = (await cleanupCount())[0]?.count;
      await rejectReceipt(() => app.inject({method:'DELETE',url:`/api/v1/receipts/${uploadId}`,headers:{
        ...headers,'x-sync-id':rejectedMutation,'x-sync-version':String(receiptVersion+100),
      }}));
      assert.equal((await db.execute(sql`select count(*)::int as count from receipts where id=${uploadId}::uuid`))[0]?.count,1);
      assert.equal((await db.execute(sql`select count(*)::int as count from media_uploads where id=${uploadId}::uuid`))[0]?.count,1);
      assert.equal((await cleanupCount())[0]?.count,beforeCleanup,'outer rollback leaves no cleanup intent');
      const deleteId=randomUUID();
      const removeReceipt=()=>app.inject({method:'DELETE',url:`/api/v1/receipts/${uploadId}`,headers:{
        ...headers,'x-sync-id':deleteId,'x-sync-version':String(receiptVersion+100),
      }});
      assert.equal((await removeReceipt()).statusCode,200);
      assert.equal((await removeReceipt()).statusCode,200,'deletion replay returns its committed receipt');
      assert.equal((await cleanupCount())[0]?.count,Number(beforeCleanup)+1);
      // Shop deletion cascades without trying to recreate a tombstone for a removed shop.
      await db.execute(
        sql`insert into receipts(shop_id,storage_path) values (${shopId}::uuid,${`${shopId}/fixture.jpg`})`,
      );
    } finally {
      await app.close();
      await db.execute(sql`delete from storage_object_deletions where shop_id=${shopId}::uuid`);
      await db.execute(sql`delete from shops where id=${shopId}::uuid`);
      await db.execute(sql`delete from auth.users where id=${userId}::uuid`);
      await connection.end({ timeout: 5 });
    }
  },
);

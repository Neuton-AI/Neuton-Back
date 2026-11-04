import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { processingDatabase } from './support/processingDatabase.js';
import { withJobTransaction } from '../src/db/job-context.js';
import { presignDocument, completeDocument, type MediaUploadDeps } from '../src/lib/mediaUploads.js';
import { DocumentProcessingService, type WorkerDeps } from '../src/modules/processing/processing.service.js';
import { runJob, JobPublicationDispatcher } from '../src/worker.js';
import { UnrecoverableError } from 'bullmq';
import { priceResult } from './support/priceResult.js';

test('worker capabilities use persisted authority, survive logout and refuse revoked or missing resources', async () => {
  const fixture = await processingDatabase();
  const { database, worker, application, actor } = fixture;
  try {
    const deps: MediaUploadDeps = {
      db: application,
      createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => ({ byteSize: 2, contentType: 'image/jpeg' }),
      enqueueMediaJob: async data => ({ queued: true, jobId: data.jobId! }),
    };
    const uploadId = randomUUID();
    await presignDocument(deps, { actor, shopId: actor.shop.id, userId: actor.user.id, currency: actor.shop.currency,
      body: { clientRequestId: uploadId, kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
    await completeDocument(deps, { actor, shopId: actor.shop.id, body: { uploadId } });
    const otherReceipt = randomUUID();
    await presignDocument(deps, { actor, shopId: actor.shop.id, userId: actor.user.id, currency: actor.shop.currency,
      body: { clientRequestId: otherReceipt, kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
    const jobId = `upload-${uploadId}`;
    await database.query('update auth_private.sessions set revoked_at=now() where id=$1', [actor.sessionId]);
    const result = await withJobTransaction(worker, jobId, async scope => {
      assert.equal(scope.shopId, actor.shop.id);
      assert.equal(scope.requestingUserId, actor.user.id);
      assert.equal(scope.resourceId, uploadId);
      assert.equal(scope.operation, 'extract_receipt');
      assert.equal(scope.sources.length, 1);
      const unauthorized = await scope.database.execute(sql`update public.receipts set merchant_name='foreign' where id=${otherReceipt}::uuid returning id`);
      assert.equal('rows' in unauthorized ? (unauthorized.rows as unknown[]).length : unauthorized.length, 0);
      await assert.rejects(scope.database.transaction(tx => tx.execute(sql`select * from auth_private.users`)), /permission denied/);
      await assert.rejects(scope.database.transaction(tx => tx.execute(sql`update public.receipts set uploaded_by=${actor.user.id}::uuid where id=${uploadId}::uuid`)), /permission denied/);
      return 'allowed';
    });
    assert.equal(result, 'allowed');
    await database.query('delete from public.shop_members where shop_id=$1 and user_id=$2', [actor.shop.id, actor.user.id]);
    assert.equal(await withJobTransaction(worker, jobId, async () => assert.fail('Revoked job must not execute')), null);
    const state = await database.query<{ state: string }>('select state from app_private.job_authorizations where job_id=$1', [jobId]);
    assert.equal(state.rows[0]!.state, 'cancelled');
    assert.equal(await withJobTransaction(worker, `upload-${randomUUID()}`, async () => assert.fail('Old database job must not execute')), null);
  } finally { await database.close(); }
});

test('recipe, product and order workers ignore forged hints, constrain writes and reauthorize terminal outcomes', async () => {
  const { database, application, worker, actor, outsideSql } = await processingDatabase();
  try {
    const uploads: MediaUploadDeps = {
      db: application, createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => ({ byteSize: 2, contentType: 'image/jpeg' }),
      enqueueMediaJob: async data => ({ queued: true, jobId: data.jobId! }),
    };
    const accept = async (kind: 'recipe' | 'product' | 'order', orderId?: string) => {
      const id = randomUUID();
      await presignDocument(uploads, { actor, shopId: actor.shop.id, userId: actor.user.id, currency: actor.shop.currency,
        body: { clientRequestId: id, kind, orderId, sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
      await completeDocument(uploads, { actor, shopId: actor.shop.id, body: { uploadId: id } });
      return id;
    };
    const deps: WorkerDeps = {
      db: worker, getObjectBytes: async key => { outsideSql(); assert.ok(key.startsWith(actor.shop.id)); return new Uint8Array([1,2]); },
      extractReceipt: async () => assert.fail('Wrong persisted kind'),
      extractRecipe: async () => {
        outsideSql(); return { name: 'Processed recipe', description: 'Recipe', prepTimeMinutes: 0, yieldQuantity: 1,
          yieldUnit: 'portion', allergens: [], steps: [], ingredients: [{ rawName: 'Flour', rawMaterialName: 'Flour',
            quantity: 100, rawSrcUnit: 'g', baseUnit: null, baseUnitAmount: null }] };
      },
      extractOrder: async () => { outsideSql(); return { customerName: 'Buyer', destinationAddress: null,
        items: [{ name: 'Processed recipe', quantity: 2, unitPrice: null }] }; },
      searchProduct: async () => { outsideSql(); return [priceResult({ itemName: 'Flour', itemPrice: '5', unitQty: 'kg', quantity: '1', score: 9500 })]; },
    };
    const job = { id: 'queue-job', updateProgress: async () => { outsideSql(); } };
    for (const kind of ['recipe','product'] as const) {
      const id = await accept(kind);
      await runJob({ jobId: `upload-${id}`, kind: 'receipt', shopId: randomUUID(), sources: [{ storagePath: 'foreign' }] }, job, deps);
      const recipe = (await database.query<{ status: string; name: string }>('select status,name from public.recipes where id=$1', [id])).rows[0]!;
      assert.equal(recipe.status, 'unverified'); assert.match(recipe.name, /^Processed recipe/);
      const links = await database.query<{ general_price_id: string }>('select general_price_id from public.recipe_ingredients where recipe_id=$1', [id]);
      assert.ok(links.rows[0]!.general_price_id);
    }
    const orderId = randomUUID();
    await database.query('insert into public.orders(id,shop_id,user_id,order_number) values($1,$2,$3,1)', [orderId, actor.shop.id, actor.user.id]);
    const orderUpload = await accept('order', orderId);
    await runJob({ jobId: `upload-${orderUpload}` }, job, deps);
    const lines = await database.query<{ quantity: string; recipe_name: string }>('select quantity,recipe_name from public.order_items where order_id=$1', [orderId]);
    assert.equal(Number(lines.rows[0]!.quantity), 2); assert.equal(lines.rows[0]!.recipe_name, 'Processed recipe');

    const failedId = await accept('recipe');
    deps.extractRecipe = async () => { outsideSql(); throw Object.assign(new Error('Private billing details'), { status: 402 }); };
    await assert.rejects(runJob({ jobId: `upload-${failedId}` }, job, deps), UnrecoverableError);
    const failed = (await database.query<{ state: string; status: string; error_message: string }>(
      'select j.state,r.status,r.error_message from app_private.job_authorizations j join public.recipes r on r.id=j.resource_id where j.upload_id=$1', [failedId])).rows[0]!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.status, 'failed'); assert.doesNotMatch(failed.error_message, /Private billing/);
    await assert.rejects(completeDocument(uploads, { actor, shopId: actor.shop.id, body: { uploadId: failedId } }), { statusCode: 409 });

    const deletedId = await accept('recipe');
    deps.extractRecipe = async () => {
      outsideSql(); await database.query('delete from public.recipes where id=$1', [deletedId]);
      return { name: 'Must not recreate', description: null, prepTimeMinutes: 0, yieldQuantity: 1,
        yieldUnit: 'portion', allergens: [], steps: [], ingredients: [] };
    };
    await runJob({ jobId: `upload-${deletedId}` }, job, deps);
    assert.equal((await database.query('select id from public.recipes where id=$1', [deletedId])).rows.length, 0);

    const editedId = await accept('recipe');
    deps.extractRecipe = async () => {
      outsideSql(); await database.query("update public.recipes set name='Human edit during extraction' where id=$1", [editedId]);
      return { name: 'Stale AI result', description: null, prepTimeMinutes: 0, yieldQuantity: 1,
        yieldUnit: 'portion', allergens: [], steps: [], ingredients: [] };
    };
    await runJob({ jobId: `upload-${editedId}` }, job, deps);
    const edited = (await database.query<{ name: string }>('select name from public.recipes where id=$1', [editedId])).rows[0]!;
    assert.equal(edited.name, 'Human edit during extraction');
    const editedJob = (await database.query<{ state: string }>('select state from app_private.job_authorizations where upload_id=$1', [editedId])).rows[0]!;
    assert.equal(editedJob.state, 'cancelled');

    const expiredId = await accept('recipe');
    await database.query("update app_private.job_authorizations set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where upload_id=$1", [expiredId]);
    assert.equal(await withJobTransaction(worker, `upload-${expiredId}`, async () => assert.fail('Expired job must not execute')), null);
    await assert.rejects(completeDocument(uploads, { actor, shopId: actor.shop.id, body: { uploadId: expiredId } }), { statusCode: 409 });

    const cancelledOrder = randomUUID();
    await database.query('insert into public.orders(id,shop_id,user_id,order_number) values($1,$2,$3,2)', [cancelledOrder, actor.shop.id, actor.user.id]);
    const cancelledUpload = await accept('order', cancelledOrder);
    deps.extractOrder = async () => {
      outsideSql(); await database.query("update public.orders set status='cancelled' where id=$1", [cancelledOrder]);
      return { customerName: 'Must not commit', destinationAddress: null, items: [{ name: 'Processed recipe', quantity: 1, unitPrice: null }] };
    };
    await runJob({ jobId: `upload-${cancelledUpload}` }, job, deps);
    const cancelled = (await database.query<{ status: string; customer_name: string | null }>('select status,customer_name from public.orders where id=$1', [cancelledOrder])).rows[0]!;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.customer_name, null);
    const cancelledJob = await database.query<{ state: string }>('select state from app_private.job_authorizations where upload_id=$1', [cancelledUpload]);
    assert.equal(cancelledJob.rows[0]!.state, 'cancelled');
    const disabledId = await accept('recipe');
    await database.query("update auth_private.users set status='disabled' where id=$1", [actor.user.id]);
    assert.equal(await withJobTransaction(worker, `upload-${disabledId}`, async () => assert.fail('Disabled requester must not execute')), null);
  } finally { await database.close(); }
});

test('publication recovery keeps accepted work after Redis failure and publishes a fixed ID outside SQL', async () => {
  const { database, application, worker, actor, outsideSql } = await processingDatabase();
  try {
    const uploadId = randomUUID();
    const uploads: MediaUploadDeps = { db: application, createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => ({ byteSize: 2, contentType: 'image/jpeg' }),
      enqueueMediaJob: async () => { throw new Error('Redis unavailable'); } };
    await presignDocument(uploads, { actor, shopId: actor.shop.id, userId: actor.user.id, currency: actor.shop.currency,
      body: { clientRequestId: uploadId, kind: 'recipe', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
    await assert.rejects(completeDocument(uploads, { actor, shopId: actor.shop.id, body: { uploadId } }), /Redis unavailable/);
    let available = false;
    const dispatcher = new JobPublicationDispatcher({ db: worker } as WorkerDeps, async data => {
      outsideSql(); assert.equal(data.jobId, `upload-${uploadId}`);
      if (!available) throw new Error('Redis unavailable');
      return { queued: true, jobId: data.jobId! };
    });
    await assert.rejects(dispatcher.drain(), /Redis unavailable/);
    const state = async () => (await database.query<{ state: string }>('select state from app_private.job_authorizations where upload_id=$1', [uploadId])).rows[0]!.state;
    assert.equal(await state(), 'accepted');
    available = true; await dispatcher.drain(); assert.equal(await state(), 'queued');
    await dispatcher.stop();
  } finally { await database.close(); }
});

test('receipt stages run external services outside SQL and commit only while current authorization survives', async () => {
  const fixture = await processingDatabase();
  const { database, worker, application, actor, outsideSql } = fixture;
  try {
    const uploads: MediaUploadDeps = {
      db: application,
      createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => ({ byteSize: 2, contentType: 'image/jpeg' }),
      enqueueMediaJob: async data => ({ queued: true, jobId: data.jobId! }),
    };
    const accept = async () => {
      const id = randomUUID();
      await presignDocument(uploads, { actor, shopId: actor.shop.id, userId: actor.user.id, currency: actor.shop.currency,
        body: { clientRequestId: id, kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] } });
      await completeDocument(uploads, { actor, shopId: actor.shop.id, body: { uploadId: id } });
      return id;
    };
    const deps: WorkerDeps = {
      db: worker,
      getObjectBytes: async () => { outsideSql(); return new Uint8Array([1,2]); },
      extractReceipt: async () => {
        outsideSql(); return { merchantName: 'Market', receiptDate: null, totalAmount: 7, taxAmount: null,
          currency: 'ILS', items: [] };
      },
      extractRecipe: async () => assert.fail('Receipt must not call recipe extraction'),
      extractOrder: async () => assert.fail('Receipt must not call order extraction'),
      searchProduct: async () => { outsideSql(); return []; },
      createSourcePreview: async source => { outsideSql(); return { storagePath: `${source.storagePath}.preview.webp`, contentType: 'image/webp', width: 20, height: 20 }; },
    };
    const service = new DocumentProcessingService(deps);
    const job = { id: 'server-job', updateProgress: async () => { outsideSql(); } };
    const id = await accept();
    assert.equal(await service.run({ jobId: `upload-${id}` }, job), true);
    const receipt = (await database.query<{ status: string; merchant_name: string }>('select status,merchant_name from public.receipts where id=$1', [id])).rows[0]!;
    assert.equal(receipt.status, 'unverified'); assert.equal(receipt.merchant_name, 'Market');
    const persisted = (await database.query<{ state: string }>('select state from app_private.job_authorizations where upload_id=$1', [id])).rows[0]!;
    assert.equal(persisted.state, 'completed');
    assert.equal(await service.run({ jobId: `upload-${id}` }, job), false);

    const deniedId = await accept();
    deps.extractReceipt = async () => {
      outsideSql();
      await database.query('delete from public.shop_members where shop_id=$1 and user_id=$2', [actor.shop.id, actor.user.id]);
      return { merchantName: 'Forbidden', receiptDate: null, totalAmount: 0, taxAmount: null, currency: 'ILS', items: [] };
    };
    assert.equal(await service.run({ jobId: `upload-${deniedId}` }, job), false);
    const denied = (await database.query<{ merchant_name: string | null }>('select merchant_name from public.receipts where id=$1', [deniedId])).rows[0]!;
    assert.equal(denied.merchant_name, null);
    await service.fail(`upload-${deniedId}`, new Error('Late failure must not restore authority'));
    const deniedState = (await database.query<{ state: string }>('select state from app_private.job_authorizations where upload_id=$1', [deniedId])).rows[0]!;
    assert.equal(deniedState.state, 'cancelled');
  } finally { await database.close(); }
});

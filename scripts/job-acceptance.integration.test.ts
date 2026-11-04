import './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../src/modules/shops/contracts.js';
import { presignDocument, completeDocument, type MediaUploadDeps } from '../src/lib/mediaUploads.js';
import type { Database } from '../src/db/client.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { apiLogger } from '../src/lib/logger/index.js';

test('upload acceptance persists authorization atomically and publication retry preserves its requester and expiry', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const sessions = new SessionRepository(auth);
    const userId = await auth.transaction(async tx => {
      const account = await accounts.createPending(tx, { email: 'jobs@example.com', fullName: 'Owner' });
      assert.ok(account); return account.user.id;
    });
    await database.query<Record<string, unknown>>("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [userId]);
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
      },
    } as unknown as Database;
    const sessionActor = {
      session: resolved.reference, sessionId: resolved.id,
      user: { id: userId, email: resolved.email, fullName: 'Owner', avatarUrl: null },
      log: apiLogger, traceId: 'accepted-job', requestId: 'accepted-job',
    };
    const shop = await new ShopsPersistence(application).create(sessionActor, createShopSchema.parse({ name: 'Jobs Kitchen' }));
    const actor = { ...sessionActor, shop, role: 'owner' } as ActorContext;
    let redisAvailable = false;
    let publications = 0;
    const deps: MediaUploadDeps = {
      db: application,
      createPresignedUploadUrl: async () => 'https://storage.test/upload',
      getObjectMetadata: async () => {
        assert.equal(activeTransactions, 0); return { byteSize: 2, contentType: 'image/jpeg' };
      },
      enqueueMediaJob: async data => {
        assert.equal(activeTransactions, 0);
        const persisted = await database.query<Record<string, unknown>>('select job_id from app_private.job_authorizations where upload_id=$1', [data.uploadId]);
        assert.equal(persisted.rows.length, 1, 'authorization must commit before Redis publication');
        if (!redisAvailable) throw new Error('Redis unavailable');
        publications += 1;
        return { queued: true, jobId: String(persisted.rows[0]!.job_id) };
      },
    };
    const uploadId = randomUUID();
    await presignDocument(deps, {
      actor, shopId: shop.id, userId, currency: shop.currency,
      body: { clientRequestId: uploadId, kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] },
    });
    const completion = { actor, body: { uploadId }, shopId: shop.id, traceId: actor.traceId };
    await assert.rejects(completeDocument(deps, completion), /Redis unavailable/);
    const first = (await database.query<Record<string, unknown>>('select * from app_private.job_authorizations where upload_id=$1', [uploadId])).rows[0]!;
    assert.equal(first.job_id, `upload-${uploadId}`);
    assert.equal(first.requesting_user_id, userId);
    assert.equal(first.shop_id, shop.id);
    assert.equal(first.resource_id, uploadId);
    assert.equal(first.operation, 'extract_receipt');
    assert.equal(first.state, 'accepted');
    assert.match(String(first.sources_digest), /^[a-f0-9]{64}$/);
    assert.equal(first.correlation_id, actor.traceId);
    redisAvailable = true;
    assert.equal((await completeDocument(deps, completion)).queued, true);
    const repeated = (await database.query<Record<string, unknown>>('select * from app_private.job_authorizations where upload_id=$1', [uploadId])).rows[0]!;
    assert.deepEqual(repeated, first, 'a retry cannot replace authorization or extend its expiry');
    assert.equal(publications, 1);

    // A failure to register must roll readiness back, leaving no publishable job.
    const invalidId = randomUUID();
    await presignDocument(deps, {
      actor, shopId: shop.id, userId, currency: shop.currency,
      body: { clientRequestId: invalidId, kind: 'receipt', sources: [{ contentType: 'image/jpeg', byteSize: 2 }] },
    });
    await database.exec(`create function app_private.reject_job_fixture() returns trigger language plpgsql as $$
      begin raise exception 'synthetic registration failure'; end $$;
      create trigger reject_job_fixture before insert on app_private.job_authorizations
      for each row execute function app_private.reject_job_fixture()`);
    await assert.rejects(completeDocument(deps, { ...completion, body: { uploadId: invalidId } }));
    const unaccepted = await database.query<Record<string, unknown>>('select queued_at from public.media_uploads where id=$1', [invalidId]);
    assert.equal(unaccepted.rows[0]!.queued_at, null);
    assert.equal(publications, 1);
  } finally { await database.close(); }
});

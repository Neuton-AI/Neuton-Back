import type { DatabaseTransaction } from './types.js';
import type { UserProcessingOperation } from './schema/jobs.js';
import type { UploadSource } from './schema/uploads.js';
import type { Database } from './client.js';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { queryRows } from './query-rows.js';
import { mediaUploads, receipts, recipes, orders } from './schema/index.js';

const JOB_CAPABILITY: unique symbol = Symbol('VerifiedJobTransaction');

/** Constructed only after the worker resolves and locks persisted authorization. */
export interface JobTransaction {
  readonly [JOB_CAPABILITY]: true;
  readonly database: DatabaseTransaction;
  readonly jobId: string;
  readonly shopId: string;
  readonly requestingUserId: string;
  readonly uploadId: string;
  readonly resourceKind: 'receipt' | 'recipe' | 'order' | 'upload';
  readonly resourceId: string;
  readonly operation: UserProcessingOperation;
  readonly sources: readonly UploadSource[];
  readonly documentId: string;
  readonly kind: 'receipt' | 'recipe' | 'product' | 'order';
  readonly correlationId: string;
  readonly resourceStatus: string;
}

const jobRow = z.object({
  job_id: z.string(), shop_id: z.string().uuid(), requesting_user_id: z.string().uuid(),
  upload_id: z.string().uuid(), resource_kind: z.enum(['receipt','recipe','order','upload']),
  resource_id: z.string().uuid(), operation: z.enum(['extract_receipt','extract_recipe','extract_order','extract_product']),
});

/** No session is required: every stage derives and locks current job authority. */
export async function withJobTransaction<T>(database: Pick<Database, 'transaction'>, jobId: string,
  work: (scope: JobTransaction) => Promise<T>, start = true): Promise<T | null> {
  if (!/^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) return null;
  return database.transaction(async transaction => {
    const [job] = await queryRows(transaction, sql`select * from app_private.claim_job_context(${jobId}::text)`, jobRow);
    const cancel = async () => {
      await transaction.execute(sql`select app_private.finish_job(${jobId}::text,'cancelled')`);
      return null;
    };
    if (!job) return cancel();
    const [association] = await transaction.select().from(mediaUploads)
      .where(and(eq(mediaUploads.id, job.upload_id), eq(mediaUploads.shopId, job.shop_id))).limit(1);
    if (!association) return cancel();
    const receiptOrRecipe = association.receiptId ?? association.recipeId;
    const documentId = receiptOrRecipe ?? association.orderId;
    if (!documentId) return cancel();
    let documentTable;
    if (association.kind === 'receipt') documentTable = receipts;
    else if (association.kind === 'order') documentTable = orders;
    else documentTable = recipes;
    const [document] = await transaction.select({ id: documentTable.id, status: documentTable.status }).from(documentTable)
      .where(and(eq(documentTable.id, documentId), eq(documentTable.shopId, job.shop_id))).limit(1).for('update');
    if (!document) return cancel();
    const [upload] = await transaction.select().from(mediaUploads)
      .where(and(eq(mediaUploads.id, job.upload_id), eq(mediaUploads.shopId, job.shop_id))).limit(1).for('update');
    if (!upload) return cancel();
    if (upload.processedAt) {
      await transaction.execute(sql`select app_private.finish_job(${jobId}::text,'completed')`);
      return null;
    }
    const [valid] = await queryRows(transaction,
      sql`select app_private.begin_job_stage(${jobId}::text,${start}::boolean) as valid`, z.object({ valid: z.boolean() }));
    if (!valid?.valid) return cancel();
    const [revision] = await queryRows(transaction,
      sql`select app_private.job_revision(${jobId}::text,false) as valid`, z.object({ valid: z.boolean() }));
    if (!revision?.valid) return cancel();
    const [correlation] = await queryRows(transaction,
      sql`select correlation_id from app_private.job_authorizations where job_id=${jobId}::text`,
      z.object({ correlation_id: z.string() }));
    if (!correlation) throw new Error('Job correlation unavailable');
    const result = await work(Object.freeze({
      [JOB_CAPABILITY]: true as const, database: transaction, jobId,
      shopId: job.shop_id, requestingUserId: job.requesting_user_id, uploadId: job.upload_id,
      resourceKind: job.resource_kind, resourceId: job.resource_id, operation: job.operation,
      sources: Object.freeze(upload.sources), documentId, kind: upload.kind, correlationId: correlation.correlation_id,
      resourceStatus: document.status,
    }));
    // Advance the baseline only for this stage's committed writes. Terminal
    // jobs return false from the routine and retain their last active baseline.
    await transaction.execute(sql`select app_private.job_revision(${jobId}::text,true)`);
    return result;
  });
}

export async function finishJob(scope: JobTransaction, outcome: 'completed' | 'failed' | 'cancelled') {
  const [result] = await queryRows(scope.database,
    sql`select app_private.finish_job(${scope.jobId}::text,${outcome}::text) as finished`, z.object({ finished: z.boolean() }));
  if (!result?.finished) throw new Error('Job authorization changed before completion');
}

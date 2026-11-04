import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { mediaUploads, orders, receipts, recipes, type UploadSource } from '../db/schema/index.js';
import { badRequest, conflict, notFound, tooLarge } from './errors.js';
import { htmlFree } from './safeText.js';
import { assertContentType, buildStoragePath, createPresignedUploadUrl, getObjectMetadata } from './storage.js';
import { enqueueMediaJob } from './queue.js';
import { env } from '../env.js';
import type { DatabaseTransaction, ShopTransaction } from '../db/types.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import { ShopOperation } from '../db/shop-operation.js';
import { requireActorRole } from '../modules/identity/authorization.js';
import { sql } from 'drizzle-orm';
import { JobAuthorizationRepository } from '../modules/processing/job-authorization.repository.js';

export const MAX_DOCUMENT_SOURCES = 4;
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = MAX_SOURCE_BYTES * MAX_DOCUMENT_SOURCES;
const kinds = z.enum(['receipt', 'recipe', 'product', 'order']);
export const sourceSchema = z.object({
  originalFilename: htmlFree(z.string().trim().max(255)).nullable().optional(),
  contentType: z.string().min(1),
  byteSize: z.number().int().positive(),
});
export const groupedPresignSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  kind: kinds,
  sources: z.array(sourceSchema).min(1).max(MAX_DOCUMENT_SOURCES),
  orderId: z.string().uuid().optional(),
});
const renewSchema = z.object({
  uploadId: z.string().uuid(),
  sourceIds: z.array(z.string().uuid()).min(1).max(MAX_DOCUMENT_SOURCES).optional(),
});
const completeSchema = z.object({ uploadId: z.string().uuid() });

export interface MediaUploadDeps {
  db: Database;
  createPresignedUploadUrl: typeof createPresignedUploadUrl;
  getObjectMetadata: typeof getObjectMetadata;
  enqueueMediaJob: typeof enqueueMediaJob;
}
export const mediaUploadServices = { createPresignedUploadUrl, getObjectMetadata, enqueueMediaJob };

export function validateSourceLimits(sources: z.infer<typeof sourceSchema>[]) {
  if (!sources.length || sources.length > MAX_DOCUMENT_SOURCES) throw badRequest('Select between 1 and 4 files');
  let total = 0;
  for (const source of sources) {
    assertContentType(source.contentType);
    if (source.byteSize > Math.min(MAX_SOURCE_BYTES, env.MAX_UPLOAD_BYTES)) throw tooLarge('Each file must be 10 MB or smaller');
    total += source.byteSize;
  }
  if (total > MAX_DOCUMENT_BYTES) throw tooLarge('A document must be 40 MB or smaller');
}

type Upload = typeof mediaUploads.$inferSelect;
export async function findUpload(db: Pick<DatabaseTransaction, 'select'>, shopId: string, uploadId: string): Promise<Upload> {
  const [upload] = await db.select().from(mediaUploads)
    .where(and(eq(mediaUploads.id, uploadId), eq(mediaUploads.shopId, shopId))).limit(1);
  if (!upload) throw notFound('Upload not found');
  return upload;
}

async function signedUpload(deps: MediaUploadDeps, upload: Upload, sourceIds?: string[]) {
  if (upload.queuedAt) throw conflict('This document has already been submitted');
  assertSourceOwnership(upload);
  const selected = sourceIds ? upload.sources.filter((source) => sourceIds.includes(source.sourceId)) : upload.sources;
  if (sourceIds?.some((id) => !upload.sources.some((source) => source.sourceId === id))) throw notFound('Upload source not found');
  const sources = await Promise.all(selected.map(async (source) => ({
    ...source, uploadUrl: await deps.createPresignedUploadUrl(source.storagePath, source.contentType),
  })));
  return {
    uploadId: upload.id, receiptId: upload.receiptId, recipeId: upload.recipeId,
    sources, method: 'PUT', expiresIn: env.UPLOAD_URL_TTL_SECONDS,
  };
}

function assertSourceOwnership(upload: Upload) {
  if (upload.sources.some((source) => !source.storagePath.startsWith(`${upload.shopId}/`))) {
    throw notFound('Upload source not found');
  }
}
function uploadIdentity(upload: Upload): string {
  return JSON.stringify([upload.id, upload.shopId, upload.uploadedBy, upload.kind,
  upload.receiptId, upload.recipeId, upload.orderId, upload.sources]);
}
async function authorizedUpload(scope: ShopTransaction, id: string, lock = false, known?: Upload): Promise<Upload> {
  const query = scope.database.select().from(mediaUploads)
    .where(and(eq(mediaUploads.id, id), eq(mediaUploads.shopId, scope.shopId))).limit(1);
  const [upload] = known ? [known] : await query;
  if (!upload) throw notFound('Upload not found');
  assertSourceOwnership(upload);
  const associations = [upload.receiptId, upload.recipeId, upload.orderId].filter(Boolean);
  const validKind = (upload.kind === 'receipt' && upload.receiptId) ||
    ((upload.kind === 'recipe' || upload.kind === 'product') && upload.recipeId) ||
    (upload.kind === 'order' && upload.orderId);
  if (associations.length !== 1 || !validKind) throw notFound('Upload resource not found');
  if (upload.receiptId) {
    const [resource] = await scope.database.select({ id: receipts.id }).from(receipts)
      .where(and(eq(receipts.id, upload.receiptId), eq(receipts.shopId, scope.shopId))).limit(1).for('key share');
    if (!resource) throw notFound('Receipt not found');
  } else if (upload.recipeId) {
    const [resource] = await scope.database.select({ id: recipes.id }).from(recipes)
      .where(and(eq(recipes.id, upload.recipeId), eq(recipes.shopId, scope.shopId), eq(recipes.isActive, true)))
      .limit(1).for('key share');
    if (!resource) throw notFound('Recipe not found');
  } else if (upload.orderId) {
    const [resource] = await scope.database.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.id, upload.orderId), eq(orders.shopId, scope.shopId), isNull(orders.deletedAt)))
      .limit(1).for('key share');
    if (!resource) throw notFound('Order not found');
  }
  if (lock) {
    const [locked] = await scope.database.select().from(mediaUploads)
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.shopId, scope.shopId))).limit(1).for('update');
    if (!locked) throw notFound('Upload not found');
    if (uploadIdentity(locked) !== uploadIdentity(upload)) throw conflict('Upload association changed');
    return locked;
  }
  return upload;
}

export async function presignDocument(deps: MediaUploadDeps, input: {
  body: unknown; actor: ActorContext; shopId: string; userId: string; currency: string;
}) {
  input = { ...input, shopId: input.actor.shop.id, userId: input.actor.user.id, currency: input.actor.shop.currency };
  if (typeof input.body === 'object' && input.body && 'uploadId' in input.body) {
    const body = renewSchema.parse(input.body);
    const upload = await new ShopOperation(deps.db).run(input.actor, async (scope, actor) => {
      requireActorRole(actor, ['owner', 'admin']);
      return authorizedUpload(scope, body.uploadId);
    });
    if (upload.queuedAt) throw conflict('This document has already been submitted');
    return signedUpload(deps, upload, body.sourceIds);
  }
  const body = groupedPresignSchema.parse(input.body);
  validateSourceLimits(body.sources);
  if (body.kind === 'order' && !body.orderId) throw badRequest('Select an order before uploading its document');
  if (body.kind !== 'order' && body.orderId) throw badRequest('Only order documents may select an order');
  const id = body.clientRequestId ?? randomUUID();
  const storageKinds = { receipt: 'receipts', recipe: 'recipes', product: 'products', order: 'orders' } as const;
  const sources: UploadSource[] = body.sources.map((source) => ({
    sourceId: randomUUID(), originalFilename: source.originalFilename ?? null,
    contentType: assertContentType(source.contentType), byteSize: source.byteSize,
    storagePath: buildStoragePath({ shopId: input.shopId, kind: storageKinds[body.kind], contentType: source.contentType }),
  }));
  const first = sources[0]!;
  const upload = await new ShopOperation(deps.db).run(input.actor, async (scope, actor) => {
    requireActorRole(actor, ['owner', 'admin']);
    const tx = scope.database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id},149))`);
    const [existing] = await tx.select().from(mediaUploads)
      .where(and(eq(mediaUploads.id, id), eq(mediaUploads.shopId, scope.shopId))).limit(1);
    if (existing) {
      const sameSources = existing.sources.length === sources.length && existing.sources.every((source, index) => {
        const requested = sources[index]!;
        return source.contentType === requested.contentType && source.byteSize === requested.byteSize &&
          source.originalFilename === requested.originalFilename;
      });
      if (existing.kind !== body.kind || existing.orderId !== (body.orderId ?? null) || !sameSources) {
        throw conflict('This upload request ID belongs to a different document');
      }
      return authorizedUpload(scope, existing.id, false, existing);
    }
    if (body.orderId) {
      const [order] = await tx.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.id, body.orderId), eq(orders.shopId, scope.shopId), isNull(orders.deletedAt)))
        .limit(1).for('key share');
      if (!order) throw notFound('Order not found');
    }
    let receiptId: string | null = null;
    let recipeId: string | null = null;
    if (body.kind === 'receipt') {
      const [receipt] = await tx.insert(receipts).values({
        // The offline placeholder and the server row share one stable identity.
        id,
        shopId: scope.shopId, uploadedBy: scope.userId, storagePath: first.storagePath,
        contentType: first.contentType, originalFilename: first.originalFilename,
        currency: input.currency, status: 'pending', progressMessage: 'Uploading document',
      }).returning({ id: receipts.id });
      if (!receipt) throw new Error('Receipt insert returned no row');
      receiptId = receipt.id;
    } else if (body.kind === 'recipe' || body.kind === 'product') {
      const [recipe] = await tx.insert(recipes).values({
        id,
        shopId: scope.shopId, name: `${(first.originalFilename ?? 'Document').slice(0, 160)} (${id})`,
        storagePath: first.storagePath, status: 'pending', yieldQuantity: '1', yieldUnit: 'portion', allergens: [],
      }).returning({ id: recipes.id });
      if (!recipe) throw new Error('Recipe insert returned no row');
      recipeId = recipe.id;
    }
    const [created] = await tx.insert(mediaUploads).values({
      id, shopId: scope.shopId, uploadedBy: scope.userId, kind: body.kind,
      sources, receiptId, recipeId, orderId: body.orderId ?? null,
    }).returning();
    if (!created) throw new Error('Upload insert returned no row');
    return created;
  });
  return signedUpload(deps, upload);
}
export async function completeDocument(deps: MediaUploadDeps, input: { body: unknown; actor: ActorContext; shopId: string; traceId?: string }) {
  const body = completeSchema.parse(input.body);
  const access = new ShopOperation(deps.db);
  const prepared = await access.run(input.actor, async (scope, actor) => {
    requireActorRole(actor, ['owner', 'admin']);
    return authorizedUpload(scope, body.uploadId);
  });
  if (!prepared.queuedAt) {
    validateSourceLimits(prepared.sources);
    for (const source of prepared.sources) {
      let actual: Awaited<ReturnType<typeof getObjectMetadata>>;
      try { actual = await deps.getObjectMetadata(source.storagePath); }
      catch { throw badRequest('A source has not finished uploading', { sourceId: source.sourceId }); }
      if (actual.byteSize !== source.byteSize || actual.contentType !== source.contentType) {
        throw badRequest('Uploaded source does not match its declared size or type', { sourceId: source.sourceId });
      }
    }
  }
  const acceptance = await access.run(input.actor, async (scope, actor) => {
    requireActorRole(actor, ['owner', 'admin']);
    const upload = await authorizedUpload(scope, body.uploadId, true);
    if (uploadIdentity(upload) !== uploadIdentity(prepared)) throw conflict('Upload association changed');
    if (!upload.queuedAt) {
      await scope.database.update(mediaUploads).set({ queuedAt: new Date() }).where(eq(mediaUploads.id, upload.id));
    }
    // Register on retries too: ON CONFLICT preserves the original requester,
    // source digest, expiry and state, including work accepted before dispatch.
    const job = await new JobAuthorizationRepository().register(scope, upload.id, actor.traceId);
    return { upload, job };
  });
  const { upload: accepted, job } = acceptance;
  const identity = { uploadId: accepted.id, receiptId: accepted.receiptId, recipeId: accepted.recipeId };
  if (accepted.processedAt) return { ...identity, queued: true, jobId: job.jobId };
  const first = accepted.sources[0]!;
  const enqueued = await deps.enqueueMediaJob({
    jobId: job.jobId,
    uploadId: accepted.id, shopId: accepted.shopId, uploadedBy: accepted.uploadedBy,
    kind: accepted.kind, sources: accepted.sources, storagePath: first.storagePath,
    contentType: first.contentType, originalFilename: first.originalFilename,
    ...(accepted.orderId ? { orderId: accepted.orderId } : {}), traceId: input.actor.traceId,
  });
  return { ...identity, ...enqueued };
}


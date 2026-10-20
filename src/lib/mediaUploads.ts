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
export async function findUpload(db: Database, shopId: string, uploadId: string): Promise<Upload> {
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

export async function presignDocument(deps: MediaUploadDeps, input: {
  body: unknown; shopId: string; userId: string; currency: string;
}) {
  if (typeof input.body === 'object' && input.body && 'uploadId' in input.body) {
    const body = renewSchema.parse(input.body);
    const upload = await findUpload(deps.db, input.shopId, body.uploadId);
    if (upload.queuedAt) throw conflict('This document has already been submitted');
    return signedUpload(deps, upload, body.sourceIds);
  }
  const body = groupedPresignSchema.parse(input.body);
  validateSourceLimits(body.sources);
  if (body.kind === 'order' && !body.orderId) throw badRequest('Select an order before uploading its document');
  if (body.orderId) {
    const [order] = await deps.db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.id, body.orderId), eq(orders.shopId, input.shopId), isNull(orders.deletedAt))).limit(1);
    if (!order) throw notFound('Order not found');
  }
  const id = body.clientRequestId ?? randomUUID();
  const storageKinds = { receipt: 'receipts', recipe: 'recipes', product: 'products', order: 'orders' } as const;
  const sources: UploadSource[] = body.sources.map((source) => ({
    sourceId: randomUUID(), originalFilename: source.originalFilename ?? null,
    contentType: assertContentType(source.contentType), byteSize: source.byteSize,
    storagePath: buildStoragePath({ shopId: input.shopId, kind: storageKinds[body.kind], contentType: source.contentType }),
  }));
  const first = sources[0]!;
  const upload = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx.insert(mediaUploads).values({
      id, shopId: input.shopId, uploadedBy: input.userId, kind: body.kind,
      sources, orderId: body.orderId ?? null,
    }).onConflictDoNothing().returning();
    if (!claimed) {
      const existing = await findUpload(tx as unknown as Database, input.shopId, id);
      const sameSources = existing.sources.length === sources.length && existing.sources.every((source, index) => {
        const requested = sources[index]!;
        return source.contentType === requested.contentType && source.byteSize === requested.byteSize &&
          source.originalFilename === requested.originalFilename;
      });
      if (existing.kind !== body.kind || existing.orderId !== (body.orderId ?? null) || !sameSources) {
        throw conflict('This upload request ID belongs to a different document');
      }
      return existing;
    }
    let receiptId: string | null = null;
    let recipeId: string | null = null;
    if (body.kind === 'receipt') {
      const [receipt] = await tx.insert(receipts).values({
        shopId: input.shopId, uploadedBy: input.userId, storagePath: first.storagePath,
        contentType: first.contentType, originalFilename: first.originalFilename,
        currency: input.currency, status: 'pending', progressMessage: 'Uploading document',
      }).returning({ id: receipts.id });
      if (!receipt) throw new Error('Receipt insert returned no row');
      receiptId = receipt.id;
    } else if (body.kind === 'recipe' || body.kind === 'product') {
      const [recipe] = await tx.insert(recipes).values({
        shopId: input.shopId, name: `${(first.originalFilename ?? 'Document').slice(0, 160)} (${id})`,
        storagePath: first.storagePath, status: 'pending', yieldQuantity: '1', yieldUnit: 'portion', allergens: [],
      }).returning({ id: recipes.id });
      if (!recipe) throw new Error('Recipe insert returned no row');
      recipeId = recipe.id;
    }
    await tx.update(mediaUploads).set({ receiptId, recipeId }).where(eq(mediaUploads.id, id));
    return { ...claimed, receiptId, recipeId };
  });
  return signedUpload(deps, upload);
}

export async function completeDocument(deps: MediaUploadDeps, input: { body: unknown; shopId: string; traceId?: string }) {
  const body = completeSchema.parse(input.body);
  const upload = await deps.db.transaction(async (tx) => {
    const [upload] = await tx.select().from(mediaUploads)
      .where(and(eq(mediaUploads.id, body.uploadId), eq(mediaUploads.shopId, input.shopId))).limit(1).for('update');
    if (!upload) throw notFound('Upload not found');
    assertSourceOwnership(upload);
    if (upload.queuedAt) return upload;
    validateSourceLimits(upload.sources);
    for (const source of upload.sources) {
      let actual: Awaited<ReturnType<typeof getObjectMetadata>>;
      try { actual = await deps.getObjectMetadata(source.storagePath); }
      catch { throw badRequest('A source has not finished uploading', { sourceId: source.sourceId }); }
      if (actual.byteSize !== source.byteSize || actual.contentType !== source.contentType) {
        throw badRequest('Uploaded source does not match its declared size or type', { sourceId: source.sourceId });
      }
    }
    // Commit readiness before touching Redis. If dispatch fails or the API crashes,
    // completion retries safely redispatch this same durable intent and stable job ID.
    await tx.update(mediaUploads).set({ queuedAt: new Date() }).where(eq(mediaUploads.id, upload.id));
    return upload;
  });
  const identity = { uploadId: upload.id, receiptId: upload.receiptId, recipeId: upload.recipeId };
  if (upload.processedAt) return { ...identity, queued: true, jobId: `upload-${upload.id}` };
  const first = upload.sources[0]!;
  const enqueued = await deps.enqueueMediaJob({
    uploadId: upload.id, shopId: input.shopId, uploadedBy: upload.uploadedBy,
    kind: upload.kind, sources: upload.sources, storagePath: first.storagePath,
    contentType: first.contentType, originalFilename: first.originalFilename,
    ...(upload.orderId ? { orderId: upload.orderId } : {}), traceId: input.traceId,
  });
  return { ...identity, ...enqueued };
}

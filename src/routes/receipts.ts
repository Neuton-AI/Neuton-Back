import { z } from 'zod';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db, type Database } from '../db/client.js';
import { receipts, receiptItems, recipes } from '../db/schema/index.js';
import { RECEIPT_STATUSES, RECIPE_STATUSES } from '../db/schema/enums.js';
import { currentShop, currentUser } from '../plugins/auth.js';
import { recordAuditSafe } from '../lib/audit.js';
import { notFound, forbidden, tooLarge, conflict } from '../lib/errors.js';
import { verifyReceipt } from '../lib/verifyReceipt.js';
import { enqueueMediaJob, type MediaKind } from '../lib/queue.js';
import {
  assertContentType,
  buildStoragePath,
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  deleteObject,
} from '../lib/storage.js';
import { env } from '../env.js';

const STORAGE_KINDS = {
  receipt: 'receipts',
  recipe: 'recipes',
  product: 'products',
  order: 'orders',
} as const;

const presignSchema = z.object({
  kind: z.enum(['receipt', 'recipe', 'product', 'order']),
  contentType: z.string().min(1),
  originalFilename: z.string().trim().max(255).nullable().optional(),
  byteSize: z.coerce.number().int().positive().optional(),
  orderId: z.string().uuid().optional(),
});

/**
 * One line's verdict, plus any corrections the reviewer made while reading it.
 * Every field is optional: omitting a correction means "the extraction was
 * right", which is what the common case looks like.
 */
const verifyItemSchema = z.object({
  id: z.string().uuid(),
  accepted: z.boolean(),
  rawName: z.string().trim().min(1).max(200).optional(),
  rawSku: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  quantity: z.coerce.number().min(0).optional(),
  unitPrice: z.coerce.number().min(0).optional(),
  totalPrice: z.coerce.number().min(0).optional(),
});

const verifySchema = z.object({
  items: z.array(verifyItemSchema).min(1).max(500),
});

/**
 * Collaborators the receipt routes write through. Injected so the verification
 * transaction and the delete endpoint's R2 cleanup can be exercised against a
 * scripted database; production always uses `defaultReceiptsDeps`.
 */
export interface ReceiptsDeps {
  db: Database;
  /** Removes the uploaded object when its row goes; a no-op seam in tests. */
  deleteObject: (key: string) => Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Per-request override of `defaultReceiptsDeps`. Production never sets it;
     * it exists so the verification and delete endpoints can be tested without
     * a live Postgres or R2 bucket.
     */
    receiptsDeps?: ReceiptsDeps;
  }
}

export const defaultReceiptsDeps: ReceiptsDeps = { db, deleteObject };

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [app.authenticate, app.resolveShop, app.requireRole(['owner', 'admin'])],
  };

  /**
   * Step 1 of the ingestion pipeline: hand the client a short-lived presigned
   * R2 URL so the browser uploads directly, bypassing the API.
   */
  app.post('/uploads/presign', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = presignSchema.parse(request.body);

    const contentType = assertContentType(body.contentType);
    if (body.byteSize && body.byteSize > env.MAX_UPLOAD_BYTES) {
      throw tooLarge(`Uploads are limited to ${env.MAX_UPLOAD_BYTES} bytes`);
    }

    const storagePath = buildStoragePath({
      shopId: shop.id,
      kind: STORAGE_KINDS[body.kind],
      contentType,
    });
    const uploadUrl = await createPresignedUploadUrl(storagePath, contentType);

    // A receipt row is created up-front so the UI can show an in-progress card.
    let receiptId: string | null = null;
    if (body.kind === 'receipt') {
      const rows = await db
        .insert(receipts)
        .values({
          shopId: shop.id,
          uploadedBy: user.id,
          storagePath,
          originalFilename: body.originalFilename ?? null,
          status: 'pending',
          currency: shop.currency,
          progressStage: 'pending',
          progressMessage: 'Uploading document',
        })
        .returning({ id: receipts.id });
      receiptId = rows[0]?.id ?? null;
    }

    return reply.code(201).send({
      uploadUrl,
      storagePath,
      receiptId,
      method: 'PUT',
      expiresIn: env.UPLOAD_URL_TTL_SECONDS,
    });
  });

  /**
   * Step 3: the client confirms the upload landed, and we enqueue the
   * Gemini Flash vision job. Safe to call only after a successful PUT.
   */
  app.post('/uploads/complete', mutationGuards, async (request, reply) => {
    const shop = currentShop(request);
    const user = currentUser(request);
    const body = z
      .object({
        storagePath: z.string().trim().min(1).max(400),
        kind: z.enum(['receipt', 'recipe', 'product', 'order']),
        contentType: z.string().min(1),
        originalFilename: z.string().trim().max(255).nullable().optional(),
        receiptId: z.string().uuid().optional(),
        orderId: z.string().uuid().optional(),
      })
      .parse(request.body);

    if (!body.storagePath.startsWith(`${shop.id}/`)) {
      throw notFound('Unknown storage path for this shop');
    }

    let receiptId = body.receiptId ?? null;
    let recipeId: string | null = null;

    if (body.kind === 'receipt') {
      if (!receiptId) {
        const rows = await db
          .insert(receipts)
          .values({
            shopId: shop.id,
            uploadedBy: user.id,
            storagePath: body.storagePath,
            contentType: body.contentType,
            originalFilename: body.originalFilename ?? null,
            status: 'pending',
            currency: shop.currency,
            progressStage: 'pending',
            progressMessage: 'Queued for processing',
          })
          .returning({ id: receipts.id });
        receiptId = rows[0]?.id ?? null;
      } else {
        await db
          .update(receipts)
          .set({
            status: 'processing',
            contentType: body.contentType,
            progressStage: 'pending',
            progressMessage: 'Queued for processing',
            updatedAt: new Date(),
          })
          .where(
            and(eq(receipts.id, receiptId), eq(receipts.shopId, shop.id)),
          );
      }
    }

    if (body.kind === 'recipe' || body.kind === 'product') {
      const originalFilename = body.originalFilename ?? 'recipe';
      const filenameBase = originalFilename.replace(/\.[^.]+$/, '');
      const storagePathParts = body.storagePath.split('/');
      const uniqueSegment = storagePathParts[storagePathParts.length - 1]?.replace(/\.[^.]+$/, '') ?? '';
      const placeholderName = `${filenameBase} (${uniqueSegment})`.slice(0, 200);

      const rows = await db
        .insert(recipes)
        .values({
          shopId: shop.id,
          name: placeholderName,
          storagePath: body.storagePath,
          status: 'pending',
          yieldQuantity: '1',
          yieldUnit: 'portion',
          allergens: [],
        })
        .returning({ id: recipes.id });
      recipeId = rows[0]?.id ?? null;
    }

    const enqueued = await enqueueMediaJob({
      shopId: shop.id,
      uploadedBy: user.id,
      kind: body.kind as MediaKind,
      storagePath: body.storagePath,
      contentType: body.contentType,
      originalFilename: body.originalFilename ?? null,
      traceId: request.traceId,
      ...(body.orderId ? { orderId: body.orderId } : {}),
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECEIPT_UPLOAD',
      resourceId: receiptId ?? recipeId,
      ipAddress: request.ip,
      metadata: { kind: body.kind, storagePath: body.storagePath, queued: enqueued.queued },
    });

    return reply.code(202).send({ receiptId, recipeId, ...enqueued });
  });

  /**
   * Applies a reviewer-approved receipt to inventory.
   *
   * The transaction, the row locks and the weighted-average arithmetic all live
   * in `lib/verifyReceipt.ts`; this handler is the guard, the request shape and
   * the audit trail around it.
   */
  // Keep legacy route for backward compatibility
  app.post('/receipts/:id/verify', mutationGuards, async (request, reply) => {
    const deps = request.receiptsDeps ?? defaultReceiptsDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = verifySchema.parse(request.body);

    const outcome = await verifyReceipt({
      db: deps.db,
      shopId: shop.id,
      userId: user.id,
      receiptId: id,
      items: body.items,
    });

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECEIPT_PROCESSED',
      resourceId: id,
      ipAddress: request.ip,
      metadata: { accepted: outcome.accepted, rejected: outcome.rejected },
    });

    return reply.code(200).send(outcome);
  });

  app.get('/receipts', guards, async (request) => {
    const shop = currentShop(request);
    const query = z
      .object({
        // Derived from the schema so `unverified`/`verified` are filterable
        // without a third hand-maintained copy drifting out of sync.
        status: z.enum(RECEIPT_STATUSES).optional(),
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const conditions = [eq(receipts.shopId, shop.id)];
    if (query.status) conditions.push(eq(receipts.status, query.status));
    if (query.search) {
      conditions.push(
        or(ilike(receipts.merchantName, `%${query.search}%`),
          ilike(receipts.originalFilename, `%${query.search}%`))!,
      );
    }

    const rows = await db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.receiptDate), desc(receipts.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    return { receipts: rows };
  });

  app.get('/receipts/:id', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    const receipt = rows[0];
    if (!receipt) throw notFound('Receipt not found');

    const items = await db
      .select()
      .from(receiptItems)
      .where(
        and(eq(receiptItems.receiptId, id), eq(receiptItems.shopId, shop.id)),
      )
      .orderBy(asc(receiptItems.id));

    // `verifiedBy`/`verifiedAt` and each line's `reviewStatus` ride along on the
    // `select()` above, so the review screen reads the whole verdict from here
    // without a second request.
    return { receipt: { ...receipt, items } };
  });

  /**
   * Deletes a receipt that has not reached `verified`.
   *
   * Status decides the semantics. Everything upstream of verification has moved
   * no stock and booked no spend, so the row is removed outright — its lines go
   * with it through the `receipt_items` cascade — and the uploaded object is
   * cleaned out of R2 behind it. `verified` is the other side of that line: the
   * receipt has already applied to inventory (`lib/verifyReceipt.ts`) and
   * analytics counts it as spend (`countedAsSpend`), and with no reversal ledger
   * to undo either, deleting it would quietly hollow out the books. It is a 409
   * that changes nothing instead. Receipts have no soft-delete state by design:
   * `status` is the lifecycle, not a tombstone.
   */
  app.delete('/receipts/:id', mutationGuards, async (request) => {
    const deps = request.receiptsDeps ?? defaultReceiptsDeps;
    const shop = currentShop(request);
    const user = currentUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const storagePath = await deps.db.transaction(async (tx) => {
      // Lock the row so "is it deletable?" and the delete are one decision —
      // a verification landing in between would otherwise erase a receipt that
      // has just moved stock.
      const rows = await tx
        .select({ status: receipts.status, storagePath: receipts.storagePath })
        .from(receipts)
        .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
        .limit(1)
        .for('update');
      const receipt = rows[0];
      if (!receipt) throw notFound('Receipt not found');
      if (receipt.status === 'verified') {
        throw conflict(
          'A verified receipt already moved stock and counted as spend; it cannot be deleted',
        );
      }

      await tx
        .delete(receipts)
        .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)));
      return receipt.storagePath;
    });

    // Row first, object second: a failed object delete then leaks a file, while
    // the other order would leave a row pointing at nothing. Never fails the
    // request either — the receipt is already gone, so a 500 would only turn a
    // successful delete into a doomed retry.
    if (storagePath) {
      try {
        await deps.deleteObject(storagePath);
      } catch (error) {
        request.log.error({ err: error, receiptId: id }, 'receipt object cleanup failed');
      }
    }

    await recordAuditSafe(app, {
      shopId: shop.id,
      userId: user.id,
      eventType: 'RECEIPT_DELETED',
      resourceId: id,
      ipAddress: request.ip,
    });

    return { ok: true };
  });

  /** Cheap polling endpoint for the "processing…" state on a receipt card. */
  app.get('/receipts/:id/status', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select({
        status: receipts.status,
        errorMessage: receipts.errorMessage,
        progressStage: receipts.progressStage,
        progressMessage: receipts.progressMessage,
        processingStartedAt: receipts.processingStartedAt,
        processingDeadline: receipts.processingDeadline,
      })
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    if (!rows[0]) throw notFound('Receipt not found');
    return rows[0];
  });

  /** Raw AI output, for the receipt detail sheet's extraction trace. */
  app.get('/receipts/:id/extraction', guards, async (request) => {
    const shop = currentShop(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db
      .select({ rawExtraction: receipts.rawExtraction })
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shop.id)))
      .limit(1);
    if (!rows[0]) throw notFound('Receipt not found');
    return { rawExtraction: rows[0].rawExtraction };
  });

  /** Count of receipts still being processed — used for polling decisions. */
  app.get('/receipts/queue/pending-count', guards, async (request) => {
    const shop = currentShop(request);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(
        and(
          eq(receipts.shopId, shop.id),
          sql`${receipts.status} in ('pending','processing')`,
        ),
      );
    return { pending: rows[0]?.count ?? 0 };
  });

  /**
   * Short-lived signed read for an already-uploaded object. Storage keys are
   * tenant-prefixed, so the prefix check is what stops one shop from signing
   * another shop's objects; the row lookup then confirms the path really is
   * theirs.
   */
  app.post('/uploads/download-url', guards, async (request) => {
    const shop = currentShop(request);
    const { path } = z.object({ path: z.string().trim().min(1).max(500) }).parse(request.body);

    if (!path.startsWith(`${shop.id}/`)) {
      throw forbidden('That file does not belong to this shop');
    }

    const rows = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.shopId, shop.id), eq(receipts.storagePath, path)))
      .limit(1);
    if (!rows[0]) throw notFound('File not found');

    return {
      url: await createPresignedDownloadUrl(path),
      expiresIn: 3600,
    };
  });
};

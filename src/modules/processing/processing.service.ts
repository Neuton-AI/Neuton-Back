import type { TransactionalDatabase } from '../../db/types.js';
import { withJobTransaction, finishJob, type JobTransaction } from '../../db/job-context.js';
import { auditLogs, mediaUploads, recipes } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { prepareSourcePreviews } from '../../lib/documentPreviews.js';
import { recordTerminalFailure as persistTerminalFailure } from './processing.persistence.js';
import { validateSourceLimits } from '../../lib/mediaUploads.js';
import type { MediaJobData } from '../../lib/queue.js';
import { getObjectBytes, putPreviewBytes } from '../../lib/storage.js';
import { createDocumentPreview, previewStoragePath } from '../../lib/documentPreviews.js';
import type { SourcePreview, UploadSource } from '../../db/schema/uploads.js';
import {
  extractReceipt,
  extractRecipe,
  extractOrder,
  type DocumentInput,
} from '../../lib/gemini.js';
import { env } from '../../env.js';
import { workerLogger } from '../../lib/logger/index.js';
import {
  enrichReciptItems,
  searchProduct,
} from '../../lib/supermarket/product-search.js';
import { convertRecipeToBaseUnits } from '../../lib/recipeConversion.js';
import { prepareRecipeFallbackPrices } from '../../lib/recipePriceFallback.js';
import { setUnitsData } from '../../lib/supermarket/conversion.js';
import type { ProcessingJob } from './contracts.js';
import {
  startReceipt,
  updateReceiptProgress,
  saveReceipt,
  claimRecipe,
  recipeShop,
  recipeLinks,
  saveRecipe,
  applyOrderDocument,
  committedLog,
} from './processing.persistence.js';
function jobLogContext(data: MediaJobData, job: ProcessingJob) {
  return {
    entryPoint: 'worker',
    requestId: data.jobId ?? job.id,
    jobId: data.jobId ?? job.id,
    kind: data.kind,
    shopId: data.shopId,
    userId: data.uploadedBy ?? undefined,
    traceId: data.traceId,
  };
}

/**
 * Collaborators each job handler reaches for. Injected so the handlers can be
 * exercised without a live Postgres, an R2 bucket or a Gemini key; production
 * injects the worker pool and `defaultWorkerServices`.
 */
export interface WorkerDeps {
  scope?: JobTransaction;
  afterCommit?: (effect: () => Promise<void>) => void;
  db: TransactionalDatabase;
  getObjectBytes: (key: string) => Promise<Uint8Array>;
  extractReceipt: typeof extractReceipt;
  extractRecipe: typeof extractRecipe;
  extractOrder: typeof extractOrder;
  searchProduct: typeof searchProduct;
  createSourcePreview?: (source: UploadSource, bytes: Uint8Array) => Promise<SourcePreview>;
}

export const defaultWorkerServices: Omit<WorkerDeps, 'db'> = {
  getObjectBytes,
  extractReceipt,
  extractRecipe,
  extractOrder,
  searchProduct,
  createSourcePreview: async (source, bytes) => {
    const preview = await createDocumentPreview(bytes, source.contentType);
    const storagePath = previewStoragePath(source.storagePath);
    await putPreviewBytes(storagePath, preview.bytes);
    return { storagePath, contentType: 'image/webp', width: preview.width, height: preview.height };
  },
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Download all parts before extraction; a missing later part never yields a partial document. */
export async function loadDocumentInput(
  deps: WorkerDeps,
  data: MediaJobData,
): Promise<DocumentInput> {
  const sources = data.sources ?? [
    { storagePath: data.storagePath, contentType: data.contentType },
  ];
  const documents = [];
  for (const source of sources) {
    if (
      !source.storagePath ||
      !source.storagePath.startsWith(`${data.shopId}/`)
    )
      throw new Error('Invalid document source');
    const bytes = await deps.getObjectBytes(source.storagePath);
    if ('byteSize' in source && bytes.byteLength !== source.byteSize)
      throw new Error('Document source size changed after submission');
    documents.push({ mimeType: source.contentType, data: toBase64(bytes) });
  }
  if (!documents[0]) throw new Error('Document has no sources');
  return { ...documents[0], ...(data.sources ? { sources: documents } : {}) };
}

function checkDeadline(deadline: Date | null): void {
  if (deadline && new Date() > deadline) {
    throw new Error('Processing deadline exceeded');
  }
}

async function withinDeadline<T>(deadline: Date, work: () => Promise<T>): Promise<T> {
  checkDeadline(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Processing deadline exceeded')), Math.max(1, deadline.getTime() - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export async function processReceipt(
  deps: WorkerDeps,
  data: MediaJobData,
  job: ProcessingJob,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process receipt without storagePath');
  }

  const jobLogger = workerLogger.child(jobLogContext(data, job));
  const startedAt = new Date();
  const deadline = new Date(
    startedAt.getTime() + env.RECEIPT_PROCESSING_TIMEOUT_MS,
  );

  await startReceipt(deps, data, storagePath, startedAt, deadline);
  const document = await loadDocumentInput(deps, data);
  checkDeadline(deadline);

  await updateReceiptProgress(
    deps,
    data.shopId,
    storagePath,
    'extracting',
    'Extracting receipt data with AI',
  );
  await job.updateProgress(10);

  const extraction = await deps.extractReceipt(
    document,
    jobLogContext(data, job),
  );
  checkDeadline(deadline);

  if (!extraction) {
    throw new Error('Gemini returned no parsable receipt extraction');
  }

  const receiptItemsWithEnrichment = await enrichReciptItems(
    extraction,
    deps.searchProduct,
  );
  const itemsWithUnitsAmounts = setUnitsData(receiptItemsWithEnrichment);

  await updateReceiptProgress(
    deps,
    data.shopId,
    storagePath,
    'validating',
    'Validating extracted data',
  );
  await job.updateProgress(30);

  await saveReceipt(
    deps,
    data,
    job,
    storagePath,
    deadline,
    extraction,
    itemsWithUnitsAmounts,
    jobLogger,
  );
  committedLog(
    deps,
    jobLogger,
    { items: extraction.items.length },
    'receipt extracted, awaiting verification',
  );
}

export async function processRecipe(
  deps: WorkerDeps,
  data: MediaJobData,
  job: ProcessingJob,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process recipe without storagePath');
  }
  const jobLogger = workerLogger.child(jobLogContext(data, job));

  // Claim the row by (shopId, storagePath) and set to 'processing'
  const existingRecipe = await claimRecipe(deps, data, storagePath);
  if (
    existingRecipe?.status === 'unverified' ||
    existingRecipe?.status === 'verified'
  )
    return;
  const document = await loadDocumentInput(deps, data);
  const extraction = await deps.extractRecipe(
    document,
    jobLogContext(data, job),
  );

  if (!extraction?.name) {
    throw new Error('Gemini returned no parsable recipe extraction');
  }

  const convertedRecipe = convertRecipeToBaseUnits(extraction);

  const shop = await recipeShop(deps, data.shopId);
  const linkedIngredientIds = await recipeLinks(
    deps,
    data.shopId,
    convertedRecipe.ingredients,
  );
  const fallbackPrices = await prepareRecipeFallbackPrices(
    convertedRecipe.ingredients.map((ingredient, index) => ({
      ...ingredient,
      inventoryItemId: linkedIngredientIds[index] ?? null,
    })),
    deps.searchProduct,
  );

  await saveRecipe(
    deps,
    data,
    storagePath,
    existingRecipe,
    extraction,
    convertedRecipe,
    linkedIngredientIds,
    fallbackPrices,
    shop,
    jobLogger,
  );
}

export async function processOrderDocument(
  deps: WorkerDeps,
  data: MediaJobData,
  job: ProcessingJob,
) {
  const storagePath = data.storagePath;
  if (!storagePath) {
    throw new Error('Cannot process order document without storagePath');
  }
  const jobLogger = workerLogger.child(jobLogContext(data, job));
  const document = await loadDocumentInput(deps, data);
  const extraction = await deps.extractOrder(
    document,
    jobLogContext(data, job),
  );

  if (!extraction || extraction.items.length === 0) {
    throw new Error('Gemini returned no parsable order extraction');
  }

  if (!data.orderId) {
    jobLogger.warn('order document uploaded without a target order');
    return;
  }

  await applyOrderDocument(deps, data, extraction, jobLogger);
}

/**
 * Records the terminal failure on the receipt/recipe row. Without this the UI polls
 * `/receipts/:id/status` or `/recipes/:id` forever on "processing" with no error to show.
 * Only fires once BullMQ has exhausted attempts, so transient failures stay
 * invisible to the shop.
 */
export { recordTerminalFailure } from './processing.persistence.js';
export { findOrCreateInventoryItem } from './processing.persistence.js';

export class DocumentProcessingService {
  constructor(private readonly deps: WorkerDeps) {}

  private stage<T>(jobId: string, work: (deps: WorkerDeps, data: MediaJobData, scope: JobTransaction) => Promise<T>) {
    return withJobTransaction(this.deps.db, jobId, scope => work(
      { ...this.deps, db: scope.database, scope }, hydratedJob(scope), scope,
    ));
  }

  async run(payload: { jobId: string }, job: ProcessingJob) {
    const startedAt = new Date();
    const deadline = new Date(startedAt.getTime() + env.RECEIPT_PROCESSING_TIMEOUT_MS);
    const data = await this.stage(payload.jobId, async (deps, current, scope) => {
      validateSourceLimits([...scope.sources]);
      if (!['pending','processing','failed'].includes(scope.resourceStatus) && current.kind !== 'order') {
        await finishJob(scope, 'cancelled'); return null;
      }
      if (current.kind === 'receipt') await startReceipt(deps, current, current.storagePath!, startedAt, deadline);
      else if (current.kind !== 'order') {
        await deps.db.update(recipes).set({ status: 'processing', errorMessage: null, updatedAt: new Date() })
          .where(eq(recipes.id, scope.documentId));
      }
      return current;
    });
    if (!data) return false;
    const log = workerLogger.child(jobLogContext(data, job));
    log.info({ event: 'document_processing_started' }, 'document processing started');
    const external = <T>(work: () => Promise<T>) => withinDeadline(deadline, work);
    const search: typeof searchProduct = (...args) => external(() => this.deps.searchProduct(...args));
    const bytes = new Map<string, Uint8Array>();
    const externalDeps = { ...this.deps, getObjectBytes: async (key: string) => {
      const value = await external(() => this.deps.getObjectBytes(key)); bytes.set(key, value); return value;
    } };
    const document = await loadDocumentInput(externalDeps, data);
    checkDeadline(deadline);
    await external(() => job.updateProgress(10));
    let commit: (deps: WorkerDeps, current: MediaJobData, scope: JobTransaction) => Promise<void>;
    const quietProgress = { id: job.id, updateProgress: async () => {} };
    if (data.kind === 'receipt') {
      const extraction = await external(() => this.deps.extractReceipt(document, jobLogContext(data, job)));
      if (!extraction) throw new Error('Gemini returned no parsable receipt extraction');
      checkDeadline(deadline);
      const enriched = await enrichReciptItems(extraction, search);
      const items = setUnitsData(enriched);
      commit = (deps, current) => saveReceipt(deps, current, quietProgress, current.storagePath!, deadline, extraction, items, log);
    } else if (data.kind === 'order') {
      const extraction = await external(() => this.deps.extractOrder(document, jobLogContext(data, job)));
      if (!extraction?.items.length) throw new Error('Gemini returned no parsable order extraction');
      commit = (deps, current) => applyOrderDocument(deps, current, extraction, log);
    } else {
      const extraction = await external(() => this.deps.extractRecipe(document, jobLogContext(data, job)));
      if (!extraction?.name) throw new Error('Gemini returned no parsable recipe extraction');
      const converted = convertRecipeToBaseUnits(extraction);
      const links = await this.stage(payload.jobId, deps => recipeLinks(deps, data.shopId, converted.ingredients));
      if (!links) return false;
      const prices = await prepareRecipeFallbackPrices(converted.ingredients.map((ingredient, index) => ({
        ...ingredient, inventoryItemId: links[index] ?? null,
      })), search);
      commit = async (deps, current, scope) => {
        const currentLinks = await recipeLinks(deps, scope.shopId, converted.ingredients);
        const shop = await recipeShop(deps, scope.shopId);
        await saveRecipe(deps, current, current.storagePath!, { id: scope.documentId, status: scope.resourceStatus },
          extraction, converted, currentLinks, prices, shop, log);
      };
    }
    checkDeadline(deadline);
    await external(() => job.updateProgress(85));
    const previewAllowed = await this.stage(payload.jobId, async (_deps, _data, scope) => {
      if (scope.resourceStatus !== 'processing') { await finishJob(scope, 'cancelled'); return false; }
      return true;
    });
    if (!previewAllowed) return false;
    const sources = this.deps.createSourcePreview ? await prepareSourcePreviews(data.sources!, async source => {
      const sourceBytes = bytes.get(source.storagePath);
      if (!sourceBytes) throw new Error('Source bytes unavailable');
      return external(() => this.deps.createSourcePreview!(source, sourceBytes));
    }, () => log.warn({ event: 'document_preview_failed' }, 'preview unavailable; original retained')) : data.sources!;
    checkDeadline(deadline);
    const effects: Array<() => Promise<void>> = [];
    const completed = await this.stage(payload.jobId, async (deps, current, scope) => {
      if (scope.resourceStatus !== 'processing') { await finishJob(scope, 'cancelled'); return false; }
      checkDeadline(deadline);
      await commit({ ...deps, afterCommit: effect => effects.push(effect) }, current, scope);
      checkDeadline(deadline);
      await scope.database.update(mediaUploads).set({ processedAt: new Date(), sources }).where(eq(mediaUploads.id, scope.uploadId));
      let eventType = 'RECIPE_UPDATED';
      if (scope.kind === 'receipt') eventType = 'RECEIPT_PROCESSED';
      else if (scope.kind === 'order') eventType = 'ORDER_UPDATED';
      await scope.database.insert(auditLogs).values({ shopId: scope.shopId, userId: scope.requestingUserId,
        eventType, resourceId: scope.documentId, metadata: { jobId: scope.jobId } });
      await finishJob(scope, 'completed');
      return true;
    });
    if (!completed) return false;
    for (const effect of effects) {
      try { await effect(); }
      catch { log.error({ event: 'processing_commit_effect_failed' }, 'post-commit effect failed'); }
    }
    log.info({ event: 'document_processing_committed' }, 'document processing completed');
    try { await job.updateProgress(100); }
    catch { log.warn({ event: 'processing_progress_unavailable' }, 'completed progress could not be published'); }
    return true;
  }

  async fail(jobId: string, error: unknown) {
    return this.stage(jobId, async (deps, data, scope) => {
      if (!['pending','processing','failed'].includes(scope.resourceStatus)) {
        await finishJob(scope, 'cancelled'); return;
      }
      await persistTerminalFailure(deps, data, error);
      await scope.database.insert(auditLogs).values({ shopId: scope.shopId, userId: scope.requestingUserId,
        eventType: 'DOCUMENT_PROCESSING_FAILED', resourceId: scope.documentId, metadata: { jobId: scope.jobId } });
      await finishJob(scope, 'failed');
    });
  }
}

export function hydratedJob(scope: JobTransaction): MediaJobData {
  const first = scope.sources[0];
  if (!first || scope.sources.some(source => !source.storagePath.startsWith(`${scope.shopId}/`))) {
    throw new Error('Invalid persisted document source');
  }
  return { jobId: scope.jobId, uploadId: scope.uploadId, shopId: scope.shopId,
    uploadedBy: scope.requestingUserId, kind: scope.kind, sources: [...scope.sources], storagePath: first.storagePath,
    contentType: first.contentType, originalFilename: first.originalFilename, traceId: scope.correlationId,
    ...(scope.kind === 'order' ? { orderId: scope.documentId } : {}),
  };
}

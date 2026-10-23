import { db, type Database } from '../../db/client.js';
import type { MediaJobData } from '../../lib/queue.js';
import { getObjectBytes } from '../../lib/storage.js';
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
} from '../../lib/supermarket/prices.js';
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
  processGroup,
} from './processing.persistence.js';
function jobLogContext(data: MediaJobData, job: ProcessingJob) {
  return {
    entryPoint: 'worker',
    requestId: job.id,
    jobId: job.id,
    kind: data.kind,
    shopId: data.shopId,
    userId: data.uploadedBy ?? undefined,
    traceId: data.traceId,
  };
}

/**
 * Collaborators each job handler reaches for. Injected so the handlers can be
 * exercised without a live Postgres, an R2 bucket or a Gemini key; production
 * always passes `defaultWorkerDeps`.
 */
export interface WorkerDeps {
  afterCommit?: (effect: () => Promise<void>) => void;
  db: Database;
  getObjectBytes: (key: string) => Promise<Uint8Array>;
  extractReceipt: typeof extractReceipt;
  extractRecipe: typeof extractRecipe;
  extractOrder: typeof extractOrder;
  searchProduct: typeof searchProduct;
}

export const defaultWorkerDeps: WorkerDeps = {
  db,
  getObjectBytes,
  extractReceipt,
  extractRecipe,
  extractOrder,
  searchProduct,
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

/**
 * Thin `WorkerDeps` wrapper over the shared inventory helper, kept so
 * `scripts/worker.test.ts` can still exercise it through the worker's own
 * signature. The handlers below deliberately do **not** use it: they take a
 * transaction handle instead, so inventory writes commit or roll back with the
 * receipt they belong to.
 */
function checkDeadline(deadline: Date | null): void {
  if (deadline && new Date() > deadline) {
    throw new Error('Processing deadline exceeded');
  }
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
  constructor(private readonly deps: WorkerDeps = defaultWorkerDeps) {}
  async run(data: MediaJobData, job: ProcessingJob) {
    const effects: Array<() => Promise<void>> = [];
    await processGroup(
      {
        ...this.deps,
        afterCommit: (effect) => {
          effects.push(effect);
        },
      },
      data,
      async (deps, current) =>
        new DocumentProcessingService(deps).process(current, job),
    );
    for (const effect of effects) await effect();
  }
  async process(data: MediaJobData, job: ProcessingJob) {
    switch (data.kind) {
      case 'receipt':
        return processReceipt(this.deps, data, job);
      case 'recipe':
      case 'product':
        return processRecipe(this.deps, data, job);
      case 'order':
        return processOrderDocument(this.deps, data, job);
      default:
        throw new Error('Unsupported document kind');
    }
  }
}

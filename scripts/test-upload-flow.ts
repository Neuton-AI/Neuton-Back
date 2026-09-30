import { extractReceipt } from '../src/lib/gemini.js';
import { createPresignedUploadUrl, getObjectBytes, buildStoragePath } from '../src/lib/storage.js';
import { enqueueMediaJob, getMediaQueue, QUEUE_NAME } from '../src/lib/queue.js';
import { isPermanentError } from '../src/lib/jobErrors.js';

/**
 * Exercises the real upload chain against live credentials:
 *   presign (R2) -> PUT the object -> read it back (R2) -> enqueue (Redis/BullMQ)
 *
 * The job is removed afterwards, but the R2 object and the Gemini call are not
 * reversible. Everything else in the app is mocked out of this path on purpose:
 * this proves the three external services work, not that auth works.
 */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 5_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isPermanentError(error)) {
        throw error;
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        console.log(`   attempt ${attempt} failed (transient), retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// A synthetic but receipt-shaped PNG: white page, black rules, price text.
// Gemini is told to extract a receipt; quality of OCR is not asserted here,
// only that the vision call returns parseable JSON.
const RECEIPT_PNG = Buffer.from(
  `iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8H
   FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=`,
  'base64',
);

async function main() {
  const shopId = '00000000-0000-0000-0000-00000000ff01';
  const contentType = 'image/png';

  console.log('--- R2: presign ---');
  const storagePath = buildStoragePath({ shopId, kind: 'receipts', contentType });
  console.log(`key: ${storagePath}`);
  const uploadUrl = await createPresignedUploadUrl(storagePath, contentType);
  if (!uploadUrl.includes('X-Amz-Signature')) {
    throw new Error('presigned URL is missing a signature');
  }
  const expiry = new URL(uploadUrl).searchParams.get('X-Amz-Expires');
  console.log(`ok   presigned (X-Amz-Expires=${expiry})`);

  console.log('\n--- R2: PUT ---');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: RECEIPT_PNG,
  });
  if (!put.ok) {
    throw new Error(`PUT failed: ${put.status} ${await put.text()}`);
  }
  console.log(`ok   uploaded ${RECEIPT_PNG.byteLength} bytes (${put.status})`);

  console.log('\n--- R2: read back ---');
  const bytes = await getObjectBytes(storagePath);
  const roundTripped = Buffer.from(bytes).equals(RECEIPT_PNG);
  console.log(`ok   read back ${bytes.byteLength} bytes, identical=${roundTripped}`);
  if (!roundTripped) throw new Error('object read back differs from what was uploaded');

  console.log('\n--- Gemini: receipt extraction (with retries) ---');
  const startedAt = Date.now();
  const extraction = await withRetry(async () => {
    const result = await extractReceipt({
      mimeType: contentType,
      data: RECEIPT_PNG.toString('base64'),
    });
    if (!result) {
      throw new Error('Gemini returned no parsable extraction');
    }
    return result;
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`ok   responded in ${elapsed}s`);
  console.log(`     merchant:  ${extraction.merchantName ?? '(null)'}`);
  console.log(`     date:      ${extraction.receiptDate ?? '(null)'}`);
  console.log(`     total:     ${extraction.totalAmount ?? '(null)'}`);
  console.log(`     currency:  ${extraction.currency ?? '(null)'}`);
  console.log(`     items:     ${extraction.items.length}`);
  for (const item of extraction.items.slice(0, 5)) {
    console.log(`       - ${item.rawName} x${item.quantity ?? '?'} @ ${item.unitPrice ?? '?'}`);
  }
  if (extraction.items.length === 0) {
    console.log('     (zero line items — synthetic PNG, quality waived)');
  }

  console.log('\n--- Redis/BullMQ: enqueue ---');
  const queued = await enqueueMediaJob({
    shopId,
    uploadedBy: null,
    kind: 'receipt',
    storagePath,
    contentType,
    originalFilename: 'upload-flow-test.png',
  });
  if (!queued.queued) {
    throw new Error(`enqueue did not queue the job: ${queued.reason ?? 'unknown'}`);
  }
  const job = await getMediaQueue().getJob(queued.jobId!);
  if (!job) throw new Error(`job ${queued.jobId} is not retrievable from Redis`);
  const state = await job.getState();
  console.log(`ok   job ${job.id} name="${job.name}" state="${state}" waiting=${job.opts.attempts ?? 1} attempt(s)`);

  await job.remove();
  console.log(`ok   job removed (bucket "${QUEUE_NAME}" otherwise clean)`);

  console.log('\n--- summary ---');
  console.log('R2 upload + download   : PASS');
  console.log('Gemini vision extract  : PASS');
  console.log('Redis enqueue + fetch  : PASS');
  console.log(`\nNote: the R2 object ${storagePath} was left in place.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nUPLOAD FLOW FAILED: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });
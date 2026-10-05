import { extractReceipt } from '../src/lib/gemini.js';
import { httpStatus, isPermanentError } from '../src/lib/jobErrors.js';
import { DEFAULT_JOB_OPTIONS } from '../src/lib/queue.js';

/**
 * Integration smoke test for the vision call. One call to `extractReceipt` is
 * one job attempt: the call itself walks `GEMINI_MODELS` in declared order and
 * advances to the next model on any non-permanent failure, so this script must
 * not re-implement model selection or an inter-model backoff. The retry loop
 * below mirrors BullMQ's job schedule (`DEFAULT_JOB_OPTIONS`) and nothing else.
 *
 * The test PNG is a blank white image, so OCR quality is irrelevant here --
 * this only proves the vision call is reachable and returns parseable JSON.
 */

const RECEIPT_PNG = Buffer.from(
  `iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8H
   FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=`,
  'base64',
);

/**
 * Read from `DEFAULT_JOB_OPTIONS` rather than restated here: this script exists
 * to mirror the real job schedule, so a copy of the numbers would drift the
 * moment the queue changes and would keep passing while lying.
 */
const JOB_ATTEMPTS = DEFAULT_JOB_OPTIONS.attempts ?? 1;
const JOB_BACKOFF_BASE_MS =
  typeof DEFAULT_JOB_OPTIONS.backoff === 'object'
    ? (DEFAULT_JOB_OPTIONS.backoff?.delay ?? 0)
    : 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('--- Gemini: receipt extraction ---');
  console.log(`test image: ${RECEIPT_PNG.byteLength} bytes, blank PNG`);
  console.log(
    `retrying as BullMQ would: ${JOB_ATTEMPTS} job attempts, ` +
      `${JOB_BACKOFF_BASE_MS / 1000}s exponential backoff\n`,
  );

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      const extraction = await extractReceipt({
        mimeType: 'image/png',
        data: RECEIPT_PNG.toString('base64'),
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      console.log(`ok   job attempt ${attempt} responded in ${elapsed}s`);
      console.log(`     merchant:  ${extraction?.merchantName ?? '(null)'}`);
      console.log(`     date:      ${extraction?.receiptDate ?? '(null)'}`);
      console.log(`     total:     ${extraction?.totalAmount ?? '(null)'}`);
      console.log(`     currency:  ${extraction?.currency ?? '(null)'}`);
      console.log(`     items:     ${extraction?.items.length ?? 0}`);
      for (const item of (extraction?.items ?? []).slice(0, 5)) {
        console.log(`       - ${item.rawName} x${item.quantity ?? '?'} @ ${item.unitPrice ?? '?'}`);
      }

      if (!extraction || extraction.items.length === 0) {
        // Expected for a blank image: the schema requires items, but Gemini may
        // legitimately return an empty array. Not a failure of the integration.
        console.log('\nnote: blank image produced zero items, which is the correct extraction.');
      }

      console.log('\nGemini integration: PASS');
      return;
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);
      const message = error instanceof Error ? error.message : String(error);

      console.log(
        `warn job attempt ${attempt} failed${status ? ` [${status}]` : ''}: ${message.split('\n')[0]}`,
      );

      if (isPermanentError(error)) {
        // Mirrors `runJob`: the worker throws `UnrecoverableError` and BullMQ
        // stops scheduling, so retrying here would only waste calls.
        console.error(`\nGemini integration: FAIL (permanent error, ${status})`);
        process.exitCode = 1;
        return;
      }
      if (attempt < JOB_ATTEMPTS) {
        const delay = JOB_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        console.log(`     retrying in ${(delay / 1000).toFixed(0)}s`);
        await sleep(delay);
      }
    }
  }

  console.error(`\nGemini integration: FAIL after ${JOB_ATTEMPTS} job attempts`);
  console.error(lastError instanceof Error ? lastError.message : String(lastError));
  process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0));
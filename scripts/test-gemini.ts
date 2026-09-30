import { extractReceipt } from '../src/lib/gemini.js';

/**
 * Retries the Gemini call on transient failures (429/5xx) with exponential
 * backoff, mirroring what the BullMQ worker does in production.
 *
 * The test PNG is a blank white image, so OCR quality is irrelevant here --
 * this only proves the vision call is reachable and returns parseable JSON.
 */

const MODEL_LABEL = 'gemini-flash-latest';
const RECEIPT_PNG = Buffer.from(
  `iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8H
   FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
   AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=`,
  'base64',
);

const MAX_ATTEMPTS = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) return status;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/"code"\s*:\s*(\d{3})/);
  return match ? Number(match[1]) : null;
}

async function main() {
  console.log(`--- Gemini: receipt extraction (${MODEL_LABEL}) ---`);
  console.log(`test image: ${RECEIPT_PNG.byteLength} bytes, blank PNG`);
  console.log(`retrying transient failures up to ${MAX_ATTEMPTS} attempts\n`);

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      const extraction = await extractReceipt({
        mimeType: 'image/png',
        data: RECEIPT_PNG.toString('base64'),
      });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

      if (!extraction) throw new Error('call succeeded but returned no parsable JSON');

      console.log(`ok   attempt ${attempt} responded in ${elapsed}s`);
      console.log(`     merchant:  ${extraction.merchantName ?? '(null)'}`);
      console.log(`     date:      ${extraction.receiptDate ?? '(null)'}`);
      console.log(`     total:     ${extraction.totalAmount ?? '(null)'}`);
      console.log(`     currency:  ${extraction.currency ?? '(null)'}`);
      console.log(`     items:     ${extraction.items.length}`);
      for (const item of extraction.items.slice(0, 5)) {
        console.log(`       - ${item.rawName} x${item.quantity ?? '?'} @ ${item.unitPrice ?? '?'}`);
      }

      if (extraction.items.length === 0) {
        // Expected for a blank image: the schema requires items, but Gemini may
        // legitimately return an empty array. Not a failure of the integration.
        console.log('\nnote: blank image produced zero items, which is the correct extraction.');
      }

      console.log('\nGemini integration: PASS');
      return;
    } catch (error) {
      lastError = error;
      const status = statusOf(error);
      const message = error instanceof Error ? error.message : String(error);
      const transient = status === null || status === 429 || status >= 500;

      console.log(`warn attempt ${attempt} failed${status ? ` [${status}]` : ''}: ${message.split('\n')[0]}`);

      if (!transient) {
        console.error(`\nGemini integration: FAIL (permanent error, ${status})`);
        process.exitCode = 1;
        return;
      }
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(5_000 * 2 ** (attempt - 1), 60_000);
        console.log(`     retrying in ${(delay / 1000).toFixed(0)}s`);
        await sleep(delay);
      }
    }
  }

  console.error(`\nGemini integration: FAIL after ${MAX_ATTEMPTS} attempts`);
  console.error(lastError instanceof Error ? lastError.message : String(lastError));
  process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0));
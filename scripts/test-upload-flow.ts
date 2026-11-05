/** Manual smoke test against an authenticated API using the supported grouped flow.
 * Requires UPLOAD_TEST_API_URL (application origin), UPLOAD_TEST_COOKIE and UPLOAD_TEST_SHOP_ID.
 * Supply a disposable test account's current session cookie via the process environment.
 * Creates one real pending document; delete it through the app after inspection.
 */
import { randomUUID } from "node:crypto";

const RECEIPT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=",
  "base64",
);
async function main() {
  const api = process.env.UPLOAD_TEST_API_URL;
  const cookie = process.env.UPLOAD_TEST_COOKIE;
  const shopId = process.env.UPLOAD_TEST_SHOP_ID;
  if (!api || !cookie || !shopId) {
    throw new Error(
      "Set UPLOAD_TEST_API_URL, UPLOAD_TEST_COOKIE and UPLOAD_TEST_SHOP_ID",
    );
  }
  const applicationUrl = new URL(api);
  const origin = applicationUrl.origin;
  const localHttp = applicationUrl.protocol === 'http:' && applicationUrl.hostname === 'localhost';
  if (api !== origin || (applicationUrl.protocol !== 'https:' && !localHttp)) {
    throw new Error('UPLOAD_TEST_API_URL must be an HTTPS application origin or local localhost origin');
  }
  const csrf = await fetch(`${origin}/api/v1/auth/csrf`, {
    method: 'POST',
    headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  if (!csrf.ok) throw new Error(`CSRF bootstrap returned ${csrf.status}`);
  const proof = await csrf.json() as { csrfToken?: unknown };
  if (typeof proof.csrfToken !== 'string') throw new Error('CSRF bootstrap returned no proof');
  const post = async (path: string, body: unknown) => {
    const response = await fetch(
      `${api.replace(/\/$/, "")}/api/v1/uploads/${path}`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': proof.csrfToken,
          "x-shop-id": shopId,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const clientRequestId = randomUUID();
  const signed = await post("presign", {
    clientRequestId,
    kind: "receipt",
    sources: [
      {
        originalFilename: "upload-flow-test.png",
        contentType: "image/png",
        byteSize: RECEIPT_PNG.length,
      },
    ],
  });
  if (
    signed.uploadId !== clientRequestId ||
    signed.receiptId !== clientRequestId
  )
    throw new Error("Document identity was not preserved");
  const sources = signed.sources as { uploadUrl: string }[];
  if (sources.length !== 1) throw new Error("Expected one signed source");
  const put = await fetch(sources[0]!.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: RECEIPT_PNG,
    signal: AbortSignal.timeout(30000),
  });
  if (!put.ok) throw new Error(`PUT returned ${put.status}`);
  const completed = await post("complete", { uploadId: clientRequestId });
  const replayed = await post("complete", { uploadId: clientRequestId });
  if (
    !completed.queued ||
    replayed.jobId !== completed.jobId ||
    replayed.receiptId !== clientRequestId
  )
    throw new Error("Completion retry did not retain its identity");
  console.log(
    `Grouped upload and completion replay passed. Review document ${clientRequestId} in the app.`,
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

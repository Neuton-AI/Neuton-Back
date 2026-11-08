/** Manual smoke test against an authenticated API using the supported grouped flow.
 * Requires UPLOAD_TEST_API_URL, UPLOAD_TEST_EMAIL, UPLOAD_TEST_PASSWORD and UPLOAD_TEST_SHOP_ID.
 * Creates one real pending document; delete it through the app after inspection.
 */
import { randomUUID } from "node:crypto";

const RECEIPT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=",
  "base64",
);
async function main() {
  const api = process.env.UPLOAD_TEST_API_URL;
  const email = process.env.UPLOAD_TEST_EMAIL;
  const password = process.env.UPLOAD_TEST_PASSWORD;
  const shopId = process.env.UPLOAD_TEST_SHOP_ID;
  if (!api || !email || !password || !shopId)
    throw new Error(
      "Set UPLOAD_TEST_API_URL, UPLOAD_TEST_EMAIL, UPLOAD_TEST_PASSWORD and UPLOAD_TEST_SHOP_ID",
    );
  const origin = new URL(api).origin;
  let cookie = '';
  let proof = '';
  const post = async (path: string, body?: unknown) => {
    const response = await fetch(
      `${origin}/api/v1/${path}`,
      {
        method: "POST",
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          ...(proof ? { 'x-csrf-token': proof } : {}),
          "x-shop-id": shopId,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    const replacement = response.headers.getSetCookie().find((value) => /neuton-(session|context)(-local)?=/.test(value));
    if (replacement) cookie = replacement.split(';')[0]!;
    return response.json() as Promise<Record<string, unknown>>;
  };
  proof = String((await post('auth/csrf')).token);
  await post('auth/signin', { email, password });
  proof = String((await post('auth/csrf')).token);
  const clientRequestId = randomUUID();
  const signed = await post("uploads/presign", {
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
  const completed = await post("uploads/complete", { uploadId: clientRequestId });
  const replayed = await post("uploads/complete", { uploadId: clientRequestId });
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

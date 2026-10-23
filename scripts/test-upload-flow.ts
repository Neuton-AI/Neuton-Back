/** Manual smoke test against an authenticated API using the supported grouped flow.
 * Requires UPLOAD_TEST_API_URL, UPLOAD_TEST_TOKEN and UPLOAD_TEST_SHOP_ID.
 * Creates one real pending document; delete it through the app after inspection.
 */
import { randomUUID } from "node:crypto";

const RECEIPT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABGCAYAAADIwUeNAAAAWklEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgH94AWZsAAAAASUVORK5CYII=",
  "base64",
);
async function main() {
  const api = process.env.UPLOAD_TEST_API_URL;
  const token = process.env.UPLOAD_TEST_TOKEN;
  const shopId = process.env.UPLOAD_TEST_SHOP_ID;
  if (!api || !token || !shopId)
    throw new Error(
      "Set UPLOAD_TEST_API_URL, UPLOAD_TEST_TOKEN and UPLOAD_TEST_SHOP_ID",
    );
  const post = async (path: string, body: unknown) => {
    const response = await fetch(
      `${api.replace(/\/$/, "")}/api/v1/uploads/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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

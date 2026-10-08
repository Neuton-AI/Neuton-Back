import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';
import { badRequest } from './errors.js';

export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

export function assertContentType(contentType: string): AllowedContentType {
  if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw badRequest(`Unsupported content type: ${contentType}`);
  }
  return contentType as AllowedContentType;
}

/** Keys are tenant-prefixed and unguessable; the original filename is never trusted. */
export function buildStoragePath(input: {
  shopId: string;
  kind: 'receipts' | 'recipes' | 'products' | 'orders';
  contentType: string;
  extension?: string;
}): string {
  const ext =
    input.extension ??
    EXTENSION_BY_TYPE[input.contentType] ??
    (input.contentType.split('/')[1] ?? 'bin');
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${input.shopId}/${input.kind}/${unique}.${ext}`;
}

export async function createPresignedUploadUrl(key: string, contentType: string) {
  return getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: env.UPLOAD_URL_TTL_SECONDS },
  );
}

export async function createPresignedDownloadUrl(key: string) {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }), {
    expiresIn: 3600,
  });
}

/**
 * Removes an uploaded object when its row goes away.
 *
 * S3/R2 answer 204 for a key that does not exist, so deleting twice — or
 * deleting an upload that never landed — is a no-op rather than an error.
 */
export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
}

/** Server-side read used by the vision worker to fetch an uploaded document. */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const result = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  if (!result.Body) throw new Error(`R2 object ${key} has no body`);
  const bytes = await result.Body.transformToByteArray();
  if (bytes.byteLength > env.MAX_UPLOAD_BYTES) {
    throw new Error(`R2 object ${key} exceeds MAX_UPLOAD_BYTES`);
  }
  return bytes;
}

export function publicAssetUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  return `${env.R2_BUCKET_NAME}/${key}`;
}

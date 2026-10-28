import { execFile } from 'node:child_process';
import sharp from 'sharp';
import type { SourcePreview, UploadSource } from '../db/schema/uploads.js';

const MAX_SIDE = 1200;
const MAX_PIXELS = 40_000_000;

/** Stable keys allow retries and deletion to recover even after a DB rollback. */
export function previewStoragePath(storagePath: string): string {
  return `${storagePath}.preview-v1.webp`;
}

export function sourceStoragePaths(source: Pick<UploadSource, 'storagePath' | 'preview'>): string[] {
  return [...new Set([source.storagePath, previewStoragePath(source.storagePath), ...(source.preview ? [source.preview.storagePath] : [])])];
}

function renderFirstPdfPage(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // No shell, user-controlled paths, or temporary files. Only page 1 reaches stdout.
    const child = execFile('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', String(MAX_SIDE), '-png', '-'],
      { encoding: 'buffer', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => { if (error) reject(error); else resolve(stdout); });
    child.stdin?.on('error', reject);
    child.stdin?.end(bytes);
  });
}

export async function createDocumentPreview(bytes: Uint8Array, contentType: string) {
  const input = contentType === 'application/pdf' ? await renderFirstPdfPage(bytes) : bytes;
  const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning', sequentialRead: true })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 80, effort: 4 })
    .timeout({ seconds: 15 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/** Optional previews never turn a usable original into a failed extraction. */
export async function prepareSourcePreviews(
  sources: UploadSource[],
  create: (source: UploadSource) => Promise<SourcePreview>,
  onFailure: (source: UploadSource) => void,
): Promise<UploadSource[]> {
  const result: UploadSource[] = [];
  for (const source of sources) {
    if (source.preview) { result.push(source); continue; }
    try { result.push({ ...source, preview: await create(source) }); }
    catch { onFailure(source); result.push(source); }
  }
  return result;
}

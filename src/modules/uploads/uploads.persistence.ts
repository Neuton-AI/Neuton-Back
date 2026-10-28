import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { mediaUploads, receipts } from '../../db/schema/index.js';
import {
  completeDocument,
  presignDocument,
  mediaUploadServices,
  type MediaUploadDeps,
} from '../../lib/mediaUploads.js';
import { createPresignedDownloadUrl } from '../../lib/storage.js';
import { notFound } from '../../lib/errors.js';
export const UPLOAD_SERVICES = Symbol('UPLOAD_SERVICES');
export interface UploadServices extends MediaUploadDeps {
  createPresignedDownloadUrl: typeof createPresignedDownloadUrl;
}
export const defaultUploadServices: UploadServices = {
  db,
  ...mediaUploadServices,
  createPresignedDownloadUrl,
};
@Injectable()
export class UploadsPersistence {
  constructor(
    @Inject(UPLOAD_SERVICES)
    private readonly services: UploadServices = defaultUploadServices,
  ) {}
  presign(input: Parameters<typeof presignDocument>[1]) {
    return presignDocument(this.services, input);
  }
  complete(input: Parameters<typeof completeDocument>[1]) {
    return completeDocument(this.services, input);
  }
  async download(shopId: string, path: string) {
    const [receipt] = await this.services.db
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.shopId, shopId), eq(receipts.storagePath, path)))
      .limit(1);
    if (!receipt) {
      const [upload] = await this.services.db
        .select({ id: mediaUploads.id })
        .from(mediaUploads)
        .where(
          and(
            eq(mediaUploads.shopId, shopId),
            sql`(${mediaUploads.sources} @> ${JSON.stringify([{ storagePath: path }])}::jsonb
              OR ${mediaUploads.sources} @> ${JSON.stringify([{ preview: { storagePath: path } }])}::jsonb)`,
          ),
        )
        .limit(1);
      if (!upload) throw notFound('File not found');
    }
    return this.services.createPresignedDownloadUrl(path);
  }
}

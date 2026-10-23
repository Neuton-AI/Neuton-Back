import { Inject, Injectable } from '@nestjs/common';
import { forbidden } from '../../lib/errors.js';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { UploadsPersistence } from './uploads.persistence.js';
import type {
  PresignedDocumentDto,
  CompletedDocumentDto,
} from './contracts.js';
@Injectable()
export class UploadsService {
  constructor(
    @Inject(UploadsPersistence)
    private readonly persistence: UploadsPersistence,
  ) {}
  async presign(
    actor: ActorContext,
    body: unknown,
  ): Promise<PresignedDocumentDto> {
    requireActorRole(actor, ['owner', 'admin']);
    const result = await this.persistence.presign({
      body,
      shopId: actor.shop.id,
      userId: actor.user.id,
      currency: actor.shop.currency,
    });
    return {
      uploadId: result.uploadId,
      receiptId: result.receiptId,
      recipeId: result.recipeId,
      sources: result.sources.map((source) => ({
        sourceId: source.sourceId,
        storagePath: source.storagePath,
        contentType: source.contentType,
        originalFilename: source.originalFilename,
        byteSize: source.byteSize,
        uploadUrl: source.uploadUrl,
      })),
      method: result.method,
      expiresIn: result.expiresIn,
    };
  }
  async complete(
    actor: ActorContext,
    body: unknown,
  ): Promise<CompletedDocumentDto> {
    requireActorRole(actor, ['owner', 'admin']);
    const result = await this.persistence.complete({
      body,
      shopId: actor.shop.id,
      traceId: actor.traceId,
    });
    actor.log.info(
      {
        event: 'upload_dispatch_completed',
        uploadId: result.uploadId,
        queued: result.queued,
      },
      'upload dispatch completed',
    );
    return {
      uploadId: result.uploadId,
      receiptId: result.receiptId,
      recipeId: result.recipeId,
      queued: result.queued,
      jobId: result.jobId,
      ...('reason' in result && result.reason ? { reason: result.reason } : {}),
    };
  }
  async download(
    actor: ActorContext,
    path: string,
  ): Promise<{ url: string; expiresIn: number }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    if (!path.startsWith(`${actor.shop.id}/`))
      throw forbidden('That file does not belong to this shop');
    return {
      url: await this.persistence.download(actor.shop.id, path),
      expiresIn: 3600,
    };
  }
}

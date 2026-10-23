import type { Response } from 'express';
import type { HttpRequest } from './request-context.js';
import type { SyncMutation } from '../modules/sync/contracts.js';
export function syncMutation(
  request: HttpRequest,
  kind: SyncMutation['kind'],
  documentId: string | null,
  status = 200,
): SyncMutation {
  return {
    mutationId: request.headers['x-sync-id'],
    version: request.headers['x-sync-version'],
    kind,
    documentId,
    status,
    method: request.method,
    path: request.originalUrl,
    body: request.body,
  };
}
export function sendMutation(
  response: Response,
  result: { status: number; body: unknown },
) {
  response.status(result.status);
  return result.body;
}

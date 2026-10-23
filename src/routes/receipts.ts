import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { db, type Database } from '../db/client.js';
import { deleteObject } from '../lib/storage.js';
import {
  mediaUploadServices,
  type MediaUploadDeps,
} from '../lib/mediaUploads.js';
import { currentShop, currentUser, currentRole } from '../plugins/auth.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import {
  ReceiptsPersistence,
  type ReceiptTransaction,
} from '../modules/receipts/receipts.persistence.js';
import {
  ReceiptsService,
  type ReceiptAfterCommit,
} from '../modules/receipts/receipts.service.js';
import {
  receiptIdSchema,
  receiptQuerySchema,
  verifySchema,
} from '../modules/receipts/contracts.js';
import { UploadsService } from '../modules/uploads/uploads.service.js';
import {
  UploadsPersistence,
  defaultUploadServices,
} from '../modules/uploads/uploads.persistence.js';
import { downloadSchema } from '../modules/uploads/contracts.js';
export interface ReceiptsDeps {
  db: Database;
  deleteObject: (key: string) => Promise<void>;
  uploads?: Omit<MediaUploadDeps, 'db'>;
}
declare module 'fastify' {
  interface FastifyRequest {
    receiptsDeps?: ReceiptsDeps;
    receiptTransaction?: {
      db: ReceiptTransaction;
      afterCommit: ReceiptAfterCommit;
    };
  }
}
export const defaultReceiptsDeps: ReceiptsDeps = { db, deleteObject };
function actor(request: FastifyRequest): ActorContext {
  return {
    shop: currentShop(request),
    user: currentUser(request),
    role: currentRole(request),
    requestId: request.id,
    traceId: request.traceId ?? request.id,
    ipAddress: request.ip,
    log: request.log,
  };
}
function service(request: FastifyRequest) {
  const instance = new ReceiptsService(
    new ReceiptsPersistence((request.receiptsDeps ?? defaultReceiptsDeps).db),
  );
  return request.receiptTransaction
    ? instance.inTransaction(
        request.receiptTransaction.db,
        request.receiptTransaction.afterCommit,
      )
    : instance;
}
function uploads(request: FastifyRequest) {
  const deps = request.receiptsDeps ?? defaultReceiptsDeps;
  return new UploadsService(
    new UploadsPersistence({
      ...defaultUploadServices,
      ...(deps.uploads ?? mediaUploadServices),
      db: deps.db,
    }),
  );
}
export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutations = {
    preHandler: [
      app.authenticate,
      app.resolveShop,
      app.requireRole(['owner', 'admin']),
    ],
  };
  app.post('/uploads/presign', mutations, async (request, reply) =>
    reply
      .code(201)
      .send(await uploads(request).presign(actor(request), request.body)),
  );
  app.post('/uploads/complete', mutations, async (request, reply) =>
    reply
      .code(202)
      .send(await uploads(request).complete(actor(request), request.body)),
  );
  app.post('/uploads/download-url', guards, async (request) =>
    uploads(request).download(
      actor(request),
      downloadSchema.parse(request.body).path,
    ),
  );
  app.get('/receipts', guards, async (request) =>
    service(request).list(
      actor(request),
      receiptQuerySchema.parse(request.query),
    ),
  );
  app.get('/receipts/queue/pending-count', guards, async (request) =>
    service(request).pending(actor(request)),
  );
  app.get('/receipts/:id', guards, async (request) =>
    service(request).detail(
      actor(request),
      receiptIdSchema.parse(request.params).id,
    ),
  );
  app.get('/receipts/:id/status', guards, async (request) =>
    service(request).status(
      actor(request),
      receiptIdSchema.parse(request.params).id,
    ),
  );
  app.post('/receipts/:id/verify', mutations, async (request) =>
    service(request).verify(
      actor(request),
      receiptIdSchema.parse(request.params).id,
      verifySchema.parse(request.body),
    ),
  );
  app.delete('/receipts/:id', mutations, async (request) =>
    service(request).delete(
      actor(request),
      receiptIdSchema.parse(request.params).id,
    ),
  );
};

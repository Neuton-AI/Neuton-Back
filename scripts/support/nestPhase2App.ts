import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { Database } from '../../src/db/client.js';
import { createHttpApplication } from '../../src/http/application.js';
import { IdentityModule } from '../../src/modules/identity/identity.module.js';
import type { ShopRole } from '../../src/modules/identity/contracts.js';
import { ReceiptsController } from '../../src/modules/receipts/receipts.controller.js';
import { ReceiptsService } from '../../src/modules/receipts/receipts.service.js';
import {
  RECEIPTS_DATABASE,
  ReceiptsPersistence,
} from '../../src/modules/receipts/receipts.persistence.js';
import { UploadsController } from '../../src/modules/uploads/uploads.controller.js';
import { UploadsService } from '../../src/modules/uploads/uploads.service.js';
import {
  UPLOAD_SERVICES,
  UploadsPersistence,
  type UploadServices,
} from '../../src/modules/uploads/uploads.persistence.js';
import { TEST_SHOP, SHOP_ID, USER_ID } from './receiptsApp.js';
export { SHOP_ID, USER_ID };
export async function buildNestPhase2App(
  database: Database,
  role: ShopRole = 'owner',
) {
  const dispatched: unknown[] = [];
  const services: UploadServices = {
    db: database,
    createPresignedUploadUrl: async () => 'https://storage.test/upload',
    getObjectMetadata: async () => ({ byteSize: 8, contentType: 'image/jpeg' }),
    enqueueMediaJob: async (data) => {
      dispatched.push(data);
      return { queued: true, jobId: `upload-${data.uploadId}` };
    },
    createPresignedDownloadUrl: async () => 'https://storage.test/download',
  };
  @Module({
    imports: [
      IdentityModule.register({
        sessionVerifier: { verify: async () => ({ id: USER_ID, email: null }) },
        repository: {
          findMembership: async (_userId, shopId) =>
            shopId === SHOP_ID ? { shopId, role } : null,
          findShop: async () => TEST_SHOP,
          findProfile: async () => null,
        },
      }),
    ],
    controllers: [ReceiptsController, UploadsController],
    providers: [
      { provide: RECEIPTS_DATABASE, useValue: database },
      ReceiptsPersistence,
      ReceiptsService,
      { provide: UPLOAD_SERVICES, useValue: services },
      UploadsPersistence,
      UploadsService,
    ],
  })
  class TestPhase2Module {}
  const app = await createHttpApplication(TestPhase2Module, {
    origins: [],
    bodyLimit: 100000,
    rateLimit: { max: 1000, windowMs: 60000 },
  });
  return { app, dispatched, close: () => app.close() };
}

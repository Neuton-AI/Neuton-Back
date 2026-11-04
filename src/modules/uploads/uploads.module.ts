import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';
import {
  UPLOAD_SERVICES,
  defaultUploadServices,
  UploadsPersistence,
} from './uploads.persistence.js';
@Module({
  imports: [IdentityModule],
  controllers: [UploadsController],
  providers: [
    { provide: UPLOAD_SERVICES, useValue: { db, ...defaultUploadServices } },
    UploadsPersistence,
    UploadsService,
  ],
  exports: [UploadsService],
})
export class UploadsModule {}

import {SyncModule} from '../sync/sync.module.js';
import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  RECEIPTS_DATABASE,
  ReceiptsPersistence,
} from './receipts.persistence.js';
import { ReceiptsService } from './receipts.service.js';
import { ReceiptsController } from './receipts.controller.js';
@Module({
  imports: [IdentityModule,SyncModule],
  controllers: [ReceiptsController],
  providers: [
    { provide: RECEIPTS_DATABASE, useValue: db },
    ReceiptsPersistence,
    ReceiptsService,
  ],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}

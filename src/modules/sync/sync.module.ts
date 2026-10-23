import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncPersistence, SYNC_DATABASE } from './sync.persistence.js';
@Module({
  imports: [IdentityModule],
  controllers: [SyncController],
  providers: [
    SyncService,
    SyncPersistence,
    { provide: SYNC_DATABASE, useValue: db },
  ],
  exports: [SyncService],
})
export class SyncModule {}

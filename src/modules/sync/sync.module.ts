import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncPersistence, SYNC_DATABASE } from './sync.persistence.js';
import { SyncEvents, SyncEventSource } from './sync-events.js';
import { PostgresSyncEvents } from './postgres-sync-events.js';
import { env } from '../../env.js';
import { SyncEventsController } from './sync-events.controller.js';
@Module({
  imports: [IdentityModule],
  controllers: [SyncController, SyncEventsController],
  providers: [
    SyncService,
    SyncPersistence,
    SyncEvents,
    {
      provide: SyncEventSource,
      inject: [SyncEvents],
      useFactory: (events: SyncEvents) => new PostgresSyncEvents(
        env.DATABASE_LISTEN_URL ?? env.DATABASE_URL, events,
      ),
    },
    { provide: SYNC_DATABASE, useValue: db },
  ],
  exports: [SyncService],
})
export class SyncModule {}

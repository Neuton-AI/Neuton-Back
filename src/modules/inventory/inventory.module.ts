import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';

import { DomainAudit } from '../../lib/domainAudit.js';
import { INVENTORY_DATABASE, InventoryPersistence } from './inventory.persistence.js';
import { InventoryService } from './inventory.service.js';
import { InventoryController } from './inventory.controller.js';
@Module({
  imports: [IdentityModule],
  controllers: [InventoryController],
  providers: [
    { provide: INVENTORY_DATABASE, useValue: db },

    InventoryPersistence, InventoryService, DomainAudit,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}

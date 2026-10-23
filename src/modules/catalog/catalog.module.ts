import { SyncModule } from '../sync/sync.module.js';
import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CATALOG_DATABASE, CatalogPersistence } from './catalog.persistence.js';
import { CatalogService, CATALOG_SEARCH } from './catalog.service.js';
import { searchProduct } from '../../lib/supermarket/prices.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogAudit } from './catalog.audit.js';

@Module({
  imports: [IdentityModule, SyncModule],
  controllers: [CatalogController],
  providers: [
    { provide: CATALOG_DATABASE, useValue: db },
    { provide: CATALOG_SEARCH, useValue: searchProduct },
    CatalogPersistence,
    CatalogService,
    CatalogAudit,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}

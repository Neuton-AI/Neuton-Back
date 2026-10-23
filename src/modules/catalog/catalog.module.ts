import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CATALOG_DATABASE, CatalogPersistence } from './catalog.persistence.js';
import { CatalogService } from './catalog.service.js';
import { CatalogController } from './catalog.controller.js';

@Module({
  imports: [IdentityModule],
  controllers: [CatalogController],
  providers: [{ provide: CATALOG_DATABASE, useValue: db }, CatalogPersistence, CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

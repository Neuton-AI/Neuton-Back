import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { ShopRole } from '../../src/modules/identity/contracts.js';
import type { CatalogReadDatabase } from '../../src/modules/catalog/catalog.persistence.js';
import { CATALOG_DATABASE, CatalogPersistence } from '../../src/modules/catalog/catalog.persistence.js';
import { CatalogController } from '../../src/modules/catalog/catalog.controller.js';
import { CatalogService } from '../../src/modules/catalog/catalog.service.js';
import { IdentityModule } from '../../src/modules/identity/identity.module.js';
import { createHttpApplication } from '../../src/http/application.js';
import { SHOP_ID, USER_ID, TEST_SHOP } from './catalogApp.js';

export { SHOP_ID };

export async function buildNestCatalogApp(database: CatalogReadDatabase, role: ShopRole = 'owner') {
  @Module({
    imports: [IdentityModule.register({
      sessionVerifier: { verify: async () => ({ id: USER_ID, email: null }) },
      repository: {
        findMembership: async (_userId, shopId) => shopId === SHOP_ID ? { shopId, role } : null,
        findShop: async () => TEST_SHOP,
        findProfile: async () => null,
      },
    })],
    controllers: [CatalogController],
    providers: [
      { provide: CATALOG_DATABASE, useValue: database }, CatalogPersistence, CatalogService,
    ],
  })
  class TestCatalogModule {}
  const app = await createHttpApplication(TestCatalogModule, {
    origins: [], bodyLimit: 100000, rateLimit: { max: 1000, windowMs: 60000 },
  });
  return { app, close: () => app.close() };
}

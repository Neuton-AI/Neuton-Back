import { Module } from '@nestjs/common';
import type { Database } from '../../src/db/client.js';
import type {
  ShopContext,
  ShopRole,
} from '../../src/modules/identity/contracts.js';
import { CatalogModule } from '../../src/modules/catalog/catalog.module.js';
import { ReceiptsModule } from '../../src/modules/receipts/receipts.module.js';
import { OrdersModule } from '../../src/modules/orders/orders.module.js';
import { SyncModule } from '../../src/modules/sync/sync.module.js';
import { CATALOG_DATABASE } from '../../src/modules/catalog/catalog.persistence.js';
import { RECEIPTS_DATABASE } from '../../src/modules/receipts/receipts.persistence.js';
import { ORDERS_DATABASE } from '../../src/modules/orders/orders.persistence.js';
import { SYNC_DATABASE } from '../../src/modules/sync/sync.persistence.js';
import {
  IdentityRepository,
  SessionVerifier,
} from '../../src/modules/identity/identity.ports.js';
import { httpClient, testApplication } from './httpClient.js';
@Module({ imports: [CatalogModule, ReceiptsModule, OrdersModule, SyncModule] })
class Root {}
export async function buildSyncApplication(
  database: Database,
  shop: ShopContext,
  userId: string,
  role: ShopRole = 'owner',
) {
  const app = await testApplication(Root, [
    [CATALOG_DATABASE, database],
    [RECEIPTS_DATABASE, database],
    [ORDERS_DATABASE, database],
    [SYNC_DATABASE, database],
    [
      SessionVerifier,
      {
        verify: async (token: string) =>
          token === 'test-session'
            ? { id: userId, email: 'sync@example.com' }
            : null,
      },
    ],
    [
      IdentityRepository,
      {
        findProfile: async () => null,
        findMembership: async (_id: string, shopId: string) =>
          shopId === shop.id ? { shopId, role } : null,
        findShop: async () => shop,
      },
    ],
  ]);
  return httpClient(app);
}

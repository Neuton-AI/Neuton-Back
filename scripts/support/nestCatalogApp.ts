import { TEST_SESSION_ID, TEST_SESSION_SECRET, TEST_SESSION_COOKIE, testIdentity } from './authIdentity.js';
import {SyncModule} from '../../src/modules/sync/sync.module.js';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { ShopRole } from '../../src/modules/identity/contracts.js';
import type { TransactionalDatabase } from '../../src/db/types.js';
import { INVENTORY_DATABASE } from '../../src/modules/inventory/inventory.persistence.js';
import { RECIPE_DATABASE } from '../../src/modules/recipes/recipe.persistence.js';
import { CATEGORIES_DATABASE } from '../../src/modules/categories/categories.persistence.js';
import { InventoryModule } from '../../src/modules/inventory/inventory.module.js';
import { RecipeModule } from '../../src/modules/recipes/recipe.module.js';
import { CategoriesModule } from '../../src/modules/categories/categories.module.js';
import { DomainAudit } from '../../src/lib/domainAudit.js';
import type { AuditInput } from '../../src/lib/audit.js';
import { IdentityRepository, SessionVerifier } from '../../src/modules/identity/identity.ports.js';
import { testApplication } from './httpClient.js';
import { SHOP_ID, USER_ID, TEST_SHOP } from './catalogApp.js';

export { SHOP_ID };

export async function buildNestCatalogApp(database: TransactionalDatabase, role: ShopRole = 'owner') {
  const audits: AuditInput[] = [];
  @Module({
    imports: [InventoryModule, RecipeModule, CategoriesModule, SyncModule],
  })
  class TestFeatureModules {}
  const app = await testApplication(TestFeatureModules, [
    [SessionVerifier, { verify: async () => (testIdentity(USER_ID)) }],
    [IdentityRepository, {
        findMembership: async (_userId: string, shopId: string) => shopId === SHOP_ID ? { shopId, role } : null,
        findShop: async () => TEST_SHOP,
        findProfile: async () => null,
    }],
    [INVENTORY_DATABASE, database], [RECIPE_DATABASE, database], [CATEGORIES_DATABASE, database],
    [DomainAudit, { record: async (_actor: unknown, input: AuditInput) => { audits.push(input); } }],
  ], {
    origins: [], bodyLimit: 100000, rateLimit: { max: 1000, windowMs: 60000 },
  });
  return { app, audits, close: () => app.close() };
}

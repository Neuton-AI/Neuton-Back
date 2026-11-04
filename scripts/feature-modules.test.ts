import { TEST_SESSION_ID, TEST_SESSION_SECRET, TEST_SESSION_COOKIE, testIdentity } from './support/authIdentity.js';
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InventoryModule } from '../src/modules/inventory/inventory.module.js';
import { INVENTORY_DATABASE } from '../src/modules/inventory/inventory.persistence.js';
import { RecipeModule } from '../src/modules/recipes/recipe.module.js';
import { RECIPE_DATABASE } from '../src/modules/recipes/recipe.persistence.js';
import { CategoriesModule } from '../src/modules/categories/categories.module.js';
import { CATEGORIES_DATABASE } from '../src/modules/categories/categories.persistence.js';
import { IdentityRepository, SessionVerifier } from '../src/modules/identity/identity.ports.js';
import { FakeDb } from './support/fakeDb.js';
import { httpClient, testApplication } from './support/httpClient.js';
import { SHOP_ID, TEST_SHOP } from './support/domainApp.js';

const headers = { cookie: TEST_SESSION_COOKIE, 'x-shop-id': SHOP_ID };

for (const feature of [
  { module: InventoryModule, database: INVENTORY_DATABASE, path: 'inventory', table: 'inventoryItems', envelope: 'items' },
  { module: RecipeModule, database: RECIPE_DATABASE, path: 'recipes', table: 'recipes', envelope: 'recipes' },
  { module: CategoriesModule, database: CATEGORIES_DATABASE, path: 'categories', table: 'categories', envelope: 'categories' },
]) {
  test(`${feature.path} module serves its own routes independently`, async () => {
    const database = new FakeDb({ [`select:${feature.table}`]: [[]] });
    const app = await testApplication(feature.module, [
      [feature.database, database],
      [SessionVerifier, { verify: async () => (testIdentity('33333333-3333-3333-3333-333333333333')) }],
      [IdentityRepository, {
        findProfile: async () => null,
        findMembership: async () => ({ shopId: SHOP_ID, role: 'member' }),
        findShop: async () => TEST_SHOP,
      }],
    ]);
    const client = httpClient(app);
    try {
      const unauthorized = await client.inject({ method: 'GET', url: `/api/v1/${feature.path}` });
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(database.calls.length, 0);
      const response = await client.inject({ method: 'GET', url: `/api/v1/${feature.path}`, headers });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { [feature.envelope]: [] });
      for (const path of ['inventory', 'recipes', 'categories'].filter(path => path !== feature.path)) {
        const absent = await client.inject({ method: 'GET', url: `/api/v1/${path}`, headers });
        assert.equal(absent.statusCode, 404, `${path} is not mounted by ${feature.path}`);
      }
    } finally {
      await client.close();
    }
  });
}

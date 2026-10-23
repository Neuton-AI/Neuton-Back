import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { costRecipe } from '../src/modules/catalog/costing.js';
import { recipes } from '../src/db/schema/index.js';
import * as tables from '../src/db/schema/index.js';

const databaseUrl = process.env.API_ALIGNMENT_TEST_DATABASE_URL;
test('real database rejects foreign links on all catalog write paths and accepts owned links', { skip: !databaseUrl && 'requires migrated disposable API_ALIGNMENT_TEST_DATABASE_URL' }, async () => {
  const namespace = `links_${randomUUID().replaceAll('-', '')}`;
  const connection = postgres(databaseUrl!, { max: 2, onnotice() {}, connection: { search_path: namespace } });
  const h = await buildCatalogApp();
  try {
    await connection.unsafe(`CREATE SCHEMA ${namespace};
      CREATE TABLE ${namespace}.categories (LIKE public.categories INCLUDING ALL);
      CREATE TABLE ${namespace}.inventory_items (LIKE public.inventory_items INCLUDING ALL);
      CREATE TABLE ${namespace}.recipes (LIKE public.recipes INCLUDING ALL);
      CREATE TABLE ${namespace}.recipe_ingredients (LIKE public.recipe_ingredients INCLUDING ALL);`);
    const database = drizzle(connection, { schema: tables });
    h.use({ db: database, deleteObject: async () => {} });
    const foreignShop = randomUUID();
    const foreignCategory = randomUUID();
    const ownedCategory = randomUUID();
    const foreignInventory = randomUUID();
    const ownedInventory = randomUUID();
    const recipe = randomUUID();
    await connection`INSERT INTO categories(id,shop_id,name) VALUES (${foreignCategory},${foreignShop},'Foreign'),(${ownedCategory},${SHOP_ID},'Owned')`;
    await connection`INSERT INTO inventory_items(id,shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost)
      VALUES (${foreignInventory},${foreignShop},'Foreign flour','flour','kg','g',1000,0.01),(${ownedInventory},${SHOP_ID},'Owned flour','flour','kg','g',1000,0.01)`;
    await connection`INSERT INTO recipes(id,shop_id,name,status) VALUES (${recipe},${SHOP_ID},'Original','unverified')`;
    const ingredient = { rawName: 'Flour', quantity: 1, rawSrcUnit: 'kg', inventoryItemId: foreignInventory };
    for (const method of ['POST', 'PATCH'] as const) {
      const url = `/api/v1/recipes${method === 'PATCH' ? `/${recipe}` : ''}`;
      for (const payload of [{ name: 'Blocked', ingredients: [ingredient] }, { name: 'Blocked', categoryId: foreignCategory, ingredients: [{ ...ingredient, inventoryItemId: ownedInventory }] }]) {
        const response = await h.app.inject({ method, url, payload });
        assert.equal(response.statusCode, 403, response.body);
      }
    }
    const verification = await h.app.inject({ method: 'POST', url: `/api/v1/recipes/${recipe}/verify`, payload: { ingredients: [ingredient] } });
    assert.equal(verification.statusCode, 403, verification.body);
    assert.deepEqual([...(await connection`SELECT name,status FROM recipes`)], [{ name: 'Original', status: 'unverified' }]);
    const inventory = { name: 'New item', rawMaterialName: 'flour', unit: 'kg', baseUnit: 'g', baseUnitAmount: 1000, baseUnitCost: 0.01, categoryId: foreignCategory };
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await h.app.inject({ method, url: `/api/v1/inventory${method === 'PATCH' ? `/${ownedInventory}` : ''}`, payload: inventory });
      assert.equal(response.statusCode, 403, response.body);
    }
    const valid = await h.app.inject({ method: 'POST', url: '/api/v1/recipes', payload: { name: 'Valid', categoryId: ownedCategory, ingredients: [{ ...ingredient, inventoryItemId: ownedInventory }] } });
    assert.equal(valid.statusCode, 201, valid.body);
    assert.equal((await connection`SELECT inventory_item_id FROM recipe_ingredients`)[0]?.inventory_item_id, ownedInventory);

    // Historical malformed links must not reveal another shop's stock/costs.
    await connection`INSERT INTO recipe_ingredients(shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,raw_src_unit,quantity,base_unit,base_unit_amount)
      VALUES (${SHOP_ID},${recipe},${foreignInventory},'Original flour','flour','kg',1,'g',1000)`;
    const [row] = await database.select().from(recipes).where(eq(recipes.id, recipe));
    assert.ok(row);
    // Keep the global-price join inside this isolated fixture as well.
    await connection.unsafe(`CREATE TABLE ${namespace}.general_prices (LIKE public.general_prices INCLUDING ALL)`);
    const costing = await costRecipe(SHOP_ID, row, '30', '25', database);
    assert.equal(costing.costComplete, false);
    assert.equal(costing.ingredients[0]?.name, 'Original flour');
    assert.equal(costing.ingredients[0]?.currentQuantity, 0);
  } finally {
    await h.close();
    await connection.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await connection.end();
  }
});

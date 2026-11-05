import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { buildSyncApplication } from './support/syncApp.js';
import { costRecipe } from '../src/modules/recipes/recipe.costing.js';
import { recipes } from '../src/db/schema/index.js';
import * as tables from '../src/db/schema/index.js';


test('real database rejects foreign links on all catalog write paths and accepts owned links', { skip: neonTestSkip, timeout: 90_000 }, async () => {
  const f = await neonFixture();
  const SHOP_ID = f.shopId;
  const database = f.admin;
  const connection = f.ownerConnection;
  let other: Awaited<ReturnType<typeof neonFixture>> | undefined;
  let app: Awaited<ReturnType<typeof buildSyncApplication>> | undefined;
  try {
    other = await neonFixture();
    const foreignShop = other.shopId;
    const client = await buildSyncApplication(f.application, f.shop, f.userId, 'owner', { id: f.sessionId, secret: f.secret });
    app = client;
    const headers = { cookie: `neuton-dev-session=${f.secret}`, 'x-shop-id': SHOP_ID };
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
        const response = await client.inject({ headers, method, url, payload });
        assert.equal(response.statusCode, 403, response.body);
      }
    }
    const verification = await client.inject({ headers, method: 'POST', url: `/api/v1/recipes/${recipe}/verify`, payload: { ingredients: [ingredient] } });
    assert.equal(verification.statusCode, 403, verification.body);
    assert.deepEqual([...(await connection`SELECT name,status FROM recipes WHERE shop_id=${SHOP_ID}`)], [{ name: 'Original', status: 'unverified' }]);
    const inventory = { name: 'New item', rawMaterialName: 'flour', unit: 'kg', baseUnit: 'g', baseUnitAmount: 1000, baseUnitCost: 0.01, categoryId: foreignCategory };
    for (const method of ['POST', 'PATCH'] as const) {
      const response = await client.inject({ headers, method, url: `/api/v1/inventory${method === 'PATCH' ? `/${ownedInventory}` : ''}`, payload: inventory });
      assert.equal(response.statusCode, 403, response.body);
    }
    const valid = await client.inject({ headers, method: 'POST', url: '/api/v1/recipes', payload: { name: 'Valid', categoryId: ownedCategory, ingredients: [{ ...ingredient, inventoryItemId: ownedInventory }] } });
    assert.equal(valid.statusCode, 201, valid.body);
    assert.equal((await connection`SELECT inventory_item_id FROM recipe_ingredients WHERE shop_id=${SHOP_ID}`)[0]?.inventory_item_id, ownedInventory);

    // Current tenant FKs reject corrupt links. A connection-local temp table
    // recreates a historical malformed line using owner-only temporary tables.
    // Costing must filter foreign stock even when its connection bypasses RLS.
    const [row] = await database.select().from(recipes).where(eq(recipes.id, recipe));
    assert.ok(row);
    await f.admin.transaction(async scoped => {
      await scoped.execute(sql`create temp table recipe_ingredients (like public.recipe_ingredients including all) on commit drop`);
      await scoped.insert(tables.recipeIngredients).values({ shopId: SHOP_ID, recipeId: recipe,
        inventoryItemId: foreignInventory, rawName: 'Original flour', rawMaterialName: 'flour',
        rawSrcUnit: 'kg', quantity: '1', baseUnit: 'g', baseUnitAmount: '1000' });
      const costing = await costRecipe(SHOP_ID, row, '30', '25', scoped);
      assert.equal(costing.costComplete, false);
      assert.equal(costing.ingredients[0]?.name, 'Original flour');
      assert.equal(costing.ingredients[0]?.currentQuantity, 0);
    });
  } finally {
    try { await app?.close(); } finally {
      try { await other?.close(); } finally { await f.close(); }
    }
  }
});

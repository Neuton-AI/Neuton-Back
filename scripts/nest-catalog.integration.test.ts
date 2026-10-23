import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import request from 'supertest';
import * as schema from '../src/db/schema/index.js';
import { buildNestCatalogApp, SHOP_ID } from './support/nestCatalogApp.js';
import { TEST_SHOP, USER_ID } from './support/catalogApp.js';
import { CatalogService } from '../src/modules/catalog/catalog.service.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { LoggerImpl } from '../src/lib/logger/index.js';
import { recipeSchema } from '../src/modules/catalog/contracts.js';

const databaseUrl = process.env.API_ALIGNMENT_TEST_DATABASE_URL;

test('Nest catalog SQL isolates shops and applies inventory and recipe lifecycle filters', {
  skip: !databaseUrl && 'requires migrated disposable API_ALIGNMENT_TEST_DATABASE_URL',
  timeout: 30_000,
}, async () => {
  const namespace = `catalog_${randomUUID().replaceAll('-', '')}`;
  const connection = postgres(databaseUrl!, {
    max: 2, onnotice() {}, connection: { search_path: namespace },
  });
  let app: Awaited<ReturnType<typeof buildNestCatalogApp>> | undefined;
  try {
    await connection.unsafe(`CREATE SCHEMA ${namespace};
      CREATE TABLE ${namespace}.categories (LIKE public.categories INCLUDING ALL);
      CREATE TABLE ${namespace}.inventory_items (LIKE public.inventory_items INCLUDING ALL);
      CREATE TABLE ${namespace}.recipes (LIKE public.recipes INCLUDING ALL);
      CREATE TABLE ${namespace}.recipe_ingredients (LIKE public.recipe_ingredients INCLUDING ALL);
      CREATE TABLE ${namespace}.general_prices (LIKE public.general_prices INCLUDING ALL);
      CREATE TABLE ${namespace}.media_uploads (LIKE public.media_uploads INCLUDING ALL);`);
    const foreignShop = randomUUID();
    await connection`INSERT INTO categories(shop_id,name) VALUES
      (${SHOP_ID},'Zulu'),(${foreignShop},'Foreign'),(${SHOP_ID},'Alpha')`;
    await connection`INSERT INTO inventory_items
      (shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,current_quantity,reorder_level,is_active)
      VALUES
      (${SHOP_ID},'Threshold','flour','kg','g',1000,0.01,2,2,true),
      (${SHOP_ID},'No threshold','flour','kg','g',1000,0.01,0,null,true),
      (${SHOP_ID},'Inactive','flour','kg','g',1000,0.01,0,1,false),
      (${foreignShop},'Foreign','flour','kg','g',1000,0.01,0,1,true)`;
    const database = drizzle(connection, { schema });
    app = await buildNestCatalogApp(database, 'member');
    const get = (path: string) => request(app!.app.getHttpServer()).get(`/api/v1${path}`)
      .set({ authorization: 'Bearer test', 'x-shop-id': SHOP_ID });
    const categories = await get('/categories');
    assert.equal(categories.status, 200);
    assert.deepEqual(categories.body.categories.map((row: { name: string }) => row.name), ['Alpha', 'Zulu']);
    const names = (response: { body: { items: { name: string }[] } }) => response.body.items.map(row => row.name);
    const inventory = await get('/inventory');
    assert.equal(inventory.status, 200);
    assert.deepEqual(names(inventory), ['No threshold', 'Threshold']);
    assert.deepEqual(inventory.body.items.map((row: { isLowStock: boolean }) => row.isLowStock), [false, true]);
    assert.deepEqual(names(await get('/inventory?search=No%20ThResHold')), ['No threshold']);
    assert.deepEqual(names(await get('/inventory?lowStockOnly=true')), ['Threshold']);
    assert.deepEqual(names(await get('/inventory?includeInactive=true&lowStockOnly=true')), ['Inactive', 'Threshold']);
    // False must keep the active-only filter; a nonempty string is not a true flag.
    assert.deepEqual(names(await get('/inventory?includeInactive=false')), ['No threshold', 'Threshold']);

    const verifiedId = randomUUID();
    const draftId = randomUUID();
    const inactiveId = randomUUID();
    const foreignId = randomUUID();
    await connection`INSERT INTO recipes(id,shop_id,name,status,is_active) VALUES
      (${verifiedId},${SHOP_ID},'Verified','verified',true),
      (${draftId},${SHOP_ID},'Draft','unverified',true),
      (${inactiveId},${SHOP_ID},'Inactive','verified',false),
      (${foreignId},${foreignShop},'Foreign','verified',true)`;
    const [ownedItem] = await connection`SELECT id FROM inventory_items WHERE shop_id=${SHOP_ID} AND name='Threshold'`;
    for (const recipeId of [verifiedId, draftId, inactiveId]) {
      await connection`INSERT INTO recipe_ingredients
        (shop_id,recipe_id,inventory_item_id,raw_name,raw_material_name,raw_src_unit,quantity,base_unit,base_unit_amount)
        VALUES (${SHOP_ID},${recipeId},${ownedItem!.id},'Reviewed flour','flour','g',100,'g',100)`;
    }
    const recipeNames = (response: { body: { recipes: { name: string }[] } }) => response.body.recipes.map(row => row.name);
    assert.deepEqual(recipeNames(await get('/recipes')), ['Verified']);
    assert.deepEqual(recipeNames(await get('/recipes?includeUnverified=true')), ['Draft', 'Verified']);
    assert.deepEqual(recipeNames(await get('/recipes?includeInactive=true&includeUnverified=true')), ['Draft', 'Inactive', 'Verified']);
    assert.deepEqual(recipeNames(await get('/recipes?includeUnverified=true&search=dRaFt')), ['Draft']);
    assert.deepEqual(recipeNames(await get('/recipes/orderable')), ['Verified']);
    const draft = await get(`/recipes/${draftId}`);
    assert.equal(draft.status, 200, 'unverified recipes remain available for review');
    assert.equal(draft.body.recipe.costing.ingredients[0].rawName, 'Reviewed flour');
    assert.deepEqual(draft.body.recipe.sources, []);
    assert.equal((await get(`/recipes/${inactiveId}`)).status, 200);
    assert.equal((await get(`/recipes/${foreignId}`)).status, 404);

    const events: Record<string, unknown>[] = [];
    const actor: ActorContext = {
      shop: TEST_SHOP, user: { id: USER_ID, email: null, fullName: null, avatarUrl: null },
      role: 'owner', requestId: 'category-test', traceId: 'category-test',
      log: new LoggerImpl({ write: (_level, _message, meta) => { events.push(meta); } }, {}, 'debug'),
    };
    const service = app.app.get(CatalogService);
    const effects: (() => Promise<void>)[] = [];
    await assert.rejects(database.transaction(async tx => {
      await service.inTransaction(tx, effect => effects.push(effect)).createCategory(actor, { name: 'Rollback category' });
      assert.equal(events.length, 0);
      throw new Error('rollback category transaction');
    }), /rollback category transaction/);
    assert.equal((await connection`SELECT count(*)::int AS count FROM categories WHERE name='Rollback category'`)[0]?.count, 0);
    assert.equal(events.length, 0);
    assert.equal(effects.length, 1);
    effects.length = 0;
    await database.transaction(async tx => {
      await service.inTransaction(tx, effect => effects.push(effect)).createCategory(actor, { name: 'Committed category' });
      assert.equal(events.length, 0);
    });
    assert.equal(events.length, 0);
    for (const effect of effects) await effect();
    assert.deepEqual(events.map(event => event.event), ['category_created']);

    events.length = 0;
    effects.length = 0;
    const recipeInput = recipeSchema.parse({
      name: 'Rollback recipe', ingredients: [{ rawName: 'User flour', quantity: 1, rawSrcUnit: 'kg' }],
    });
    await assert.rejects(database.transaction(async tx => {
      await service.inTransaction(tx, effect => effects.push(effect)).createRecipe(actor, recipeInput);
      assert.equal(app!.audits.length, 0);
      assert.equal(events.length, 0);
      throw new Error('rollback recipe transaction');
    }), /rollback recipe transaction/);
    assert.equal((await connection`SELECT count(*)::int AS count FROM recipes WHERE name='Rollback recipe'`)[0]?.count, 0);
    assert.equal(app.audits.length, 0);
    assert.equal(events.length, 0);
    effects.length = 0;
    await database.transaction(async tx => {
      await service.inTransaction(tx, effect => effects.push(effect)).createRecipe(actor, {
        ...recipeInput, name: 'Committed recipe',
      });
      assert.equal(app!.audits.length, 0);
    });
    assert.equal(app.audits.length, 0);
    for (const effect of effects) await effect();
    assert.deepEqual(app.audits.map(audit => audit.eventType), ['RECIPE_CREATED']);
    assert.deepEqual(events.map(event => event.event), ['recipe_created']);
  } finally {
    await app?.close();
    await connection.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
    await connection.end({ timeout: 5 });
  }
});

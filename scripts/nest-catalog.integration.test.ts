import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as schema from '../src/db/schema/index.js';
import { CategoriesService } from '../src/modules/categories/categories.service.js';
import { RecipeService } from '../src/modules/recipes/recipe.service.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { LoggerImpl } from '../src/lib/logger/index.js';
import { recipeSchema } from '../src/modules/recipes/contracts.js';
import { neonFixture, neonTestSkip } from './support/neonFixture.js';
import { buildSyncApplication } from './support/syncApp.js';

test('Nest catalog SQL isolates shops and applies inventory and recipe lifecycle filters', {
  skip: neonTestSkip,
  timeout: 90_000,
}, async () => {
  const f = await neonFixture();
  const SHOP_ID = f.shopId;
  const connection = f.ownerConnection;
  const database = f.application;
  let other: Awaited<ReturnType<typeof neonFixture>> | undefined;
  let app: Awaited<ReturnType<typeof buildSyncApplication>> | undefined;
  try {
    const member = await neonFixture();
    other = member;
    const foreignShop = member.shopId;
    await f.admin.insert(schema.shopMembers).values({ shopId: SHOP_ID, userId: member.userId, role: 'member' });
    await connection`INSERT INTO categories(shop_id,name) VALUES
      (${SHOP_ID},'Zulu'),(${foreignShop},'Foreign'),(${SHOP_ID},'Alpha')`;
    await connection`INSERT INTO inventory_items
      (shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost,current_quantity,reorder_level,is_active)
      VALUES
      (${SHOP_ID},'Threshold','flour','kg','g',1000,0.01,2,2,true),
      (${SHOP_ID},'No threshold','flour','kg','g',1000,0.01,0,null,true),
      (${SHOP_ID},'Inactive','flour','kg','g',1000,0.01,0,1,false),
      (${foreignShop},'Foreign','flour','kg','g',1000,0.01,0,1,true)`;
    app = await buildSyncApplication(database, f.shop, member.userId, 'member', { id: member.sessionId, secret: member.secret });
    const get = (path: string) => request(app!.nest.getHttpServer()).get(`/api/v1${path}`)
      .set({ cookie: `neuton-dev-session=${member.secret}`, 'x-shop-id': SHOP_ID });
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
      ...f.actor,
      log: new LoggerImpl({ write: (_level, _message, meta) => { events.push(meta); } }, {}, 'debug'),
    };
    const audits = () => connection`select id from public.audit_logs where shop_id=${SHOP_ID} and event_type='RECIPE_CREATED'`;
    const service = app.nest.get(CategoriesService);
    const effects: (() => Promise<void>)[] = [];
    await assert.rejects(f.inShop(async scope => {
      await service.inTransaction(scope, effect => effects.push(effect)).createCategory(actor, { name: 'Rollback category' });
      assert.equal(events.length, 0);
      throw new Error('rollback category transaction');
    }), /rollback category transaction/);
    assert.equal((await connection`SELECT count(*)::int AS count FROM categories WHERE shop_id=${SHOP_ID} AND name='Rollback category'`)[0]?.count, 0);
    assert.equal(events.length, 0);
    assert.equal(effects.length, 1);
    effects.length = 0;
    await f.inShop(async scope => {
      await service.inTransaction(scope, effect => effects.push(effect)).createCategory(actor, { name: 'Committed category' });
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
    const recipeService = app.nest.get(RecipeService);
    await assert.rejects(f.inShop(async scope => {
      await recipeService.inTransaction(scope, effect => effects.push(effect)).createRecipe(actor, recipeInput);
      assert.equal((await audits()).length, 0);
      assert.equal(events.length, 0);
      throw new Error('rollback recipe transaction');
    }), /rollback recipe transaction/);
    assert.equal((await connection`SELECT count(*)::int AS count FROM recipes WHERE shop_id=${SHOP_ID} AND name='Rollback recipe'`)[0]?.count, 0);
    assert.equal((await audits()).length, 0);
    assert.equal(events.length, 0);
    effects.length = 0;
    await f.inShop(async scope => {
      await recipeService.inTransaction(scope, effect => effects.push(effect)).createRecipe(actor, {
        ...recipeInput, name: 'Committed recipe',
      });
      assert.equal((await audits()).length, 0);
    });
    assert.equal((await audits()).length, 1, 'recipe audit commits with its mutation');
    for (const effect of effects) await effect();
    assert.equal((await audits()).length, 1);
    assert.deepEqual(events.map(event => event.event), ['recipe_created']);
  } finally {
    try { await app?.close(); } finally {
      try { await other?.close(); } finally { await f.close(); }
    }
  }
});

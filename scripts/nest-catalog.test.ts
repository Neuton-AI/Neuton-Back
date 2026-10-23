import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import type { Database } from '../src/db/client.js';
import type { Category, InventoryItem, Recipe } from '../src/db/schema/catalog.js';
import { FakeDb } from './support/fakeDb.js';
import { buildNestCatalogApp, SHOP_ID } from './support/nestCatalogApp.js';
import { buildCatalogApp } from './support/catalogApp.js';

const createdAt = new Date('2026-01-01T00:00:00Z');
const category = {
  id: '11111111-1111-1111-1111-111111111111', shopId: SHOP_ID,
  name: 'Flour', createdAt,
} satisfies Category;
const inventory = {
  id: '44444444-4444-4444-4444-444444444444', shopId: SHOP_ID,
  categoryId: category.id, name: 'Flour', rawMaterialName: 'flour', sku: null,
  imageUrl: null, unit: 'kg', baseUnit: 'g', baseUnitAmount: '1000.000',
  baseUnitCost: '0.002000', baseUnitAverageCost: '0.001500',
  currentQuantity: '2.000', reorderLevel: '2.000', lastUnitCost: '2.0000',
  averageUnitCost: '1.5000', isActive: true, createdAt, updatedAt: createdAt,
} satisfies InventoryItem;
const headers = { authorization: 'Bearer test', 'x-shop-id': SHOP_ID };
const recipe = {
  id: '66666666-6666-6666-6666-666666666666', shopId: SHOP_ID,
  categoryId: category.id, name: 'Reviewed bread', description: null,
  imageUrl: null, prepTimeMinutes: 0, yieldQuantity: '2.000', yieldUnit: 'portion',
  targetMarginPct: null, allergens: ['gluten'],
  steps: [{ stepNumber: 1, instruction: 'Use the reviewed quantity' }],
  isActive: true, status: 'unverified', storagePath: `${SHOP_ID}/recipe.jpg`,
  errorMessage: null, createdAt, updatedAt: createdAt,
} satisfies Recipe;
const ingredient = {
  id: 'line', inventoryItemId: inventory.id, generalPriceId: null,
  rawName: 'User corrected flour', rawMaterialName: 'corrected flour',
  rawSrcUnit: 'g', baseUnit: 'g', baseUnitAmount: '100.000', quantity: '100.000',
  name: 'Flour', currentQuantity: '0.000', averageUnitCost: '0.002000',
};

test('Nest catalog reads map explicit fields and preserve legacy decimal/date envelopes', async () => {
  const database = new FakeDb({
    'select:categories': [[{ ...category, privateColumn: 'do not expose' }], [category]],
    'select:inventoryItems': [
      [{ ...inventory, privateColumn: 'do not expose' }, { ...inventory, reorderLevel: null }],
      [inventory, { ...inventory, reorderLevel: null }],
    ],
  });
  const db = database as unknown as Database;
  const nest = await buildNestCatalogApp(db, 'member');
  const legacy = await buildCatalogApp('member');
  legacy.use({ db, deleteObject: async () => {} });
  try {
    for (const path of ['/categories', '/inventory']) {
      const next = await request(nest.app.getHttpServer()).get(`/api/v1${path}`).set(headers);
      const previous = await legacy.app.inject({ method: 'GET', url: `/api/v1${path}` });
      assert.equal(next.status, 200);
      assert.equal(previous.statusCode, 200);
      assert.deepEqual(next.body, previous.json());
      assert.equal(JSON.stringify(next.body).includes('privateColumn'), false);
      if (path === '/categories') {
        assert.deepEqual(next.body.categories, [JSON.parse(JSON.stringify(category))]);
      }
      if (path === '/inventory') {
        assert.deepEqual(next.body.items[0], { ...JSON.parse(JSON.stringify(inventory)), isLowStock: true });
        assert.equal(next.body.items[0].baseUnitCost, '0.002000');
        assert.equal(next.body.items[0].createdAt, createdAt.toISOString());
        assert.equal(next.body.items[0].isLowStock, true, 'threshold equality counts as low');
        assert.equal(next.body.items[1].isLowStock, false, 'no threshold is not low stock');
      }
    }
  } finally {
    await nest.close();
    await legacy.close();
  }
});

test('Nest catalog rejects unauthenticated, foreign-shop and invalid queries before reads', async () => {
  const database = new FakeDb();
  const nest = await buildNestCatalogApp(database as unknown as Database);
  try {
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/categories')).status, 401);
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/inventory').set({
      ...headers, 'x-shop-id': '55555555-5555-5555-5555-555555555555',
    })).status, 403);
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/inventory').query({
      search: 'x'.repeat(121),
    }).set(headers)).status, 400);
    assert.equal(database.calls.length, 0);
  } finally {
    await nest.close();
  }
});

test('Nest recipe list/detail preserve reviewed values with explicit nested DTOs and legacy parity', async () => {
  const row = { ...recipe, privateColumn: 'hidden', steps: [{ ...recipe.steps[0]!, privateNote: 'hidden' }] };
  const source = {
    sourceId: 'page', storagePath: `${SHOP_ID}/page.jpg`, contentType: 'image/jpeg',
    originalFilename: 'bread.jpg', byteSize: 50, privateNote: 'hidden',
  };
  const database = new FakeDb({
    'select:recipes': [[row], [row], [row], [row]],
    'select:recipeIngredients': [[ingredient], [ingredient], [ingredient], [ingredient]],
    'select:mediaUploads': [[{ sources: [source] }], [{ sources: [source] }]],
  });
  const db = database as unknown as Database;
  const nest = await buildNestCatalogApp(db, 'member');
  const legacy = await buildCatalogApp('member');
  legacy.use({ db, deleteObject: async () => {} });
  try {
    for (const path of ['/recipes?includeUnverified=true', `/recipes/${recipe.id}`]) {
      const next = await request(nest.app.getHttpServer()).get(`/api/v1${path}`).set(headers);
      const previous = await legacy.app.inject({ method: 'GET', url: `/api/v1${path}` });
      assert.equal(next.status, 200);
      assert.deepEqual(next.body, previous.json());
      const value = next.body.recipe ?? next.body.recipes[0];
      const { costing, sources, ...publicRecipe } = value;
      assert.deepEqual(publicRecipe, JSON.parse(JSON.stringify(recipe)), 'retain every existing public recipe field');
      assert.deepEqual(value.steps, recipe.steps);
      assert.equal(value.yieldQuantity, '2.000');
      assert.equal(value.createdAt, createdAt.toISOString());
      assert.equal(costing.ingredients[0].rawName, 'User corrected flour');
      assert.equal(costing.ingredients[0].baseUnitAmount, '100.000');
      assert.equal(costing.inStock, false);
      assert.equal(costing.unitCost, 0.1);
      assert.equal(JSON.stringify(next.body).includes('hidden'), false);
      if (sources) assert.deepEqual(sources, [{
        sourceId: source.sourceId, storagePath: source.storagePath, contentType: source.contentType,
        originalFilename: source.originalFilename, byteSize: source.byteSize,
      }]);
    }
  } finally {
    await nest.close();
    await legacy.close();
  }
});

test('static orderable route includes costed out-of-stock recipes and excludes unresolved costs', async () => {
  const database = new FakeDb({
    'select:recipes': [[{ ...recipe, status: 'verified' }, { ...recipe, id: category.id, status: 'verified' }]],
    'select:recipeIngredients': [[ingredient], [{ ...ingredient, averageUnitCost: null }]],
  });
  const nest = await buildNestCatalogApp(database as unknown as Database);
  try {
    const response = await request(nest.app.getHttpServer()).get('/api/v1/recipes/orderable').set(headers);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { recipes: [{
      id: recipe.id, name: recipe.name, imageUrl: null, yieldQuantity: '2.000', yieldUnit: 'portion',
      costComplete: true, unitCost: 0.1, retailPrice: 0.13,
    }] });
    assert.equal((await request(nest.app.getHttpServer()).get('/api/v1/recipes/not-a-uuid').set(headers)).status, 400);
    assert.equal((await request(nest.app.getHttpServer()).get(`/api/v1/recipes/${recipe.id}`).set(headers)).status, 404);
  } finally {
    await nest.close();
  }
});

test('category creation validates input, enforces roles, and maps the committed row explicitly', async () => {
  const database = new FakeDb({ 'insert:categories': [[{ ...category, privateColumn: 'hidden' }]] });
  const nest = await buildNestCatalogApp(database as unknown as Database);
  const memberDatabase = new FakeDb();
  const member = await buildNestCatalogApp(memberDatabase as unknown as Database, 'member');
  try {
    const invalid = await request(nest.app.getHttpServer()).post('/api/v1/categories').set(headers)
      .send({ name: '<script>bad</script>' });
    assert.equal(invalid.status, 400);
    assert.equal(database.calls.length, 0);
    assert.equal((await request(member.app.getHttpServer()).post('/api/v1/categories')
      .set(headers).send({ name: 'Flour' })).status, 403);
    assert.deepEqual(memberDatabase.calls, []);
    const created = await request(nest.app.getHttpServer()).post('/api/v1/categories').set(headers)
      .send({ name: '  Flour  ' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { category: JSON.parse(JSON.stringify(category)) });
    assert.deepEqual(database.onlyCallTo('insert', 'categories').values, { shopId: SHOP_ID, name: 'Flour' });
  } finally {
    await nest.close();
    await member.close();
  }
});

test('recipe creation stays pending, preserves supplied ingredient values, and checks roles and owned links', async () => {
  const created = { ...recipe, status: 'pending', categoryId: null };
  const database = new FakeDb({ 'insert:recipes': [[created]], 'insert:recipeIngredients': [[]] });
  const nest = await buildNestCatalogApp(database as unknown as Database);
  const memberDb = new FakeDb();
  const member = await buildNestCatalogApp(memberDb as unknown as Database, 'member');
  const payload = {
    name: recipe.name, status: 'verified', steps: recipe.steps,
    ingredients: [{ rawName: 'User corrected flour', rawMaterialName: 'corrected flour', quantity: 1,
      rawSrcUnit: 'kg', baseUnit: 'g', baseUnitAmount: 1000 }],
  };
  try {
    assert.equal((await request(nest.app.getHttpServer()).post('/api/v1/recipes').set(headers)
      .send({ ...payload, name: '<script>bad</script>' })).status, 400);
    assert.equal(database.calls.length, 0);
    assert.equal((await request(member.app.getHttpServer()).post('/api/v1/recipes').set(headers).send(payload)).status, 403);
    assert.equal(memberDb.calls.length, 0);
    assert.equal((await request(nest.app.getHttpServer()).post('/api/v1/recipes').set(headers)
      .send({ ...payload, categoryId: '55555555-5555-5555-5555-555555555555' })).status, 403);
    assert.equal(database.calls.filter(call => call.op !== 'select').length, 0);
    const response = await request(nest.app.getHttpServer()).post('/api/v1/recipes').set(headers).send(payload);
    assert.equal(response.status, 201);
    assert.equal(response.body.recipe.status, 'pending');
    const stored = database.onlyCallTo('insert', 'recipes').values as Record<string, unknown>;
    assert.equal(stored.status, 'pending');
    assert.equal(stored.name, recipe.name);
    assert.equal(stored.shopId, SHOP_ID);
    const lines = database.onlyCallTo('insert', 'recipeIngredients').values;
    assert.deepEqual(lines, [{ shopId: SHOP_ID, recipeId: recipe.id, inventoryItemId: null, generalPriceId: null,
      rawName: 'User corrected flour', rawMaterialName: 'corrected flour', quantity: '1.000', rawSrcUnit: 'kg',
      baseUnit: 'g', baseUnitAmount: '1000.000' }]);
    assert.equal(database.transactionCount, 2, 'foreign-link attempt rolls back before successful create');
    assert.equal(database.calls.filter(call => call.op === 'insert').every(call => call.inTransaction), true);
    assert.deepEqual(nest.audits.map(audit => audit.eventType), ['RECIPE_CREATED']);
  } finally {
    await nest.close();
    await member.close();
  }
});

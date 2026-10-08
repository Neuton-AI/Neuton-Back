/**
 * Recipe delete tests for N-107.
 *
 * The behaviour under test is one branch point: a recipe that nothing has ever
 * ordered is removed outright, while a recipe order lines still reference
 * refuses (FK `23503`) and the delete deactivates instead. `FakeDb` stands in
 * for the database, so the FK refusal is scripted — which is exactly what lets
 * the fallback be asserted without a live Postgres, and why the `23503` on
 * `order_items.recipe_id` is pinned to the schema below: if that action ever
 * stops being `restrict`, no refusal arrives and every delete goes hard.
 */
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { FakeDb } from './support/fakeDb.js';
import { buildCatalogApp, SHOP_ID } from './support/catalogApp.js';
import { orderItems, recipeIngredients, recipes } from '../src/db/schema/index.js';

const RECIPE_ID = '66666666-6666-6666-6666-666666666666';
const STORAGE_PATH = `${SHOP_ID}/recipes/uploaded.pdf`;

/** What postgres.js reports when a child row still points at the recipe. */
function foreignKeyViolation(): Error {
  return Object.assign(
    new Error(
      'insert or update on table "order_items" violates foreign key constraint "order_items_recipe_id_foreign"',
    ),
    { code: '23503' },
  );
}

async function harness(
  responses: Record<string, unknown[]> = {},
  options: { deleteFails?: boolean } = {},
) {
  const db = new FakeDb(responses);
  const app = await buildCatalogApp();
  const deleted: string[] = [];
  app.use({
    db: db as never,
    deleteObject: async (key: string) => {
      deleted.push(key);
      if (options.deleteFails) throw new Error('R2 unreachable');
    },
  });

  return {
    db,
    deleted,
    async del(url: string) {
      const response = await app.app.inject({ method: 'DELETE', url });
      return { status: response.statusCode, body: response.json() as any };
    },
    close: () => app.close(),
  };
}

/** The `ON DELETE` action Postgres takes for one column's foreign key. */
function onDeleteOf(table: PgTable, columnName: string): string | null {
  for (const foreignKey of getTableConfig(table).foreignKeys) {
    const reference = foreignKey.reference();
    if (reference.columns.some((column) => column.name === columnName)) {
      return foreignKey.onDelete ?? 'no action';
    }
  }
  return null;
}

test('DELETE /recipes/:id hard-deletes an unordered recipe, its object, and its name', async () => {
  const h = await harness({
    'select:recipes': [[{ id: RECIPE_ID, storagePath: STORAGE_PATH }]],
    'delete:recipes': [[]],
  });
  try {
    const { status, body } = await h.del(`/api/v1/recipes/${RECIPE_ID}`);

    assert.equal(status, 200);
    assert.equal(body.mode, 'hard');
    assert.deepEqual(
      h.db.callSequence(),
      ['select:recipes', 'delete:recipes'],
      'the row is read, then removed — no update kept it alive',
    );
    assert.deepEqual(h.deleted, [STORAGE_PATH], 'the uploaded document goes with the row');
    assert.equal(h.db.transactionCount, 1, 'the delete ran as one transaction');
    // "Frees the name" only means anything because the name is claimed per shop:
    // once the row is gone the unique index no longer holds it.
    assert.ok(
      getTableConfig(recipes).indexes.some((index) => index.config.name === 'recipes_shop_id_name_unique'),
      'the recipe name is a per-shop unique resource',
    );
  } finally {
    await h.close();
  }
});

test('DELETE /recipes/:id deactivates a recipe order lines still reference', async () => {
  const db = new FakeDb({
    'select:recipes': [[{ id: RECIPE_ID, storagePath: STORAGE_PATH }]],
    'update:recipes': [[{ id: RECIPE_ID }]],
  });
  db.failOn('delete', 'recipes', foreignKeyViolation());
  const app = await buildCatalogApp();
  const deleted: string[] = [];
  app.use({ db: db as never, deleteObject: async (key) => { deleted.push(key); } });

  try {
    const response = await app.app.inject({ method: 'DELETE', url: `/api/v1/recipes/${RECIPE_ID}` });
    const body = response.json() as any;

    assert.equal(response.statusCode, 200, 'the refusal degrades the delete, it does not fail it');
    assert.equal(body.mode, 'soft');
    assert.deepEqual(db.callSequence(), ['select:recipes', 'delete:recipes', 'update:recipes']);

    const update = db.onlyCallTo('update', 'recipes');
    assert.equal(update.set?.isActive, false);
    assert.equal(update.set?.storagePath, null, 'the deactivated recipe points at no object');
    assert.equal(update.set?.imageUrl, null);
    assert.ok(update.set?.updatedAt instanceof Date, 'the change is stamped');
    assert.deepEqual(deleted, [STORAGE_PATH], 'the document is dropped either way');
    assert.equal(db.transactionCount, 1, 'the refusal happened inside the delete transaction');
  } finally {
    await app.close();
  }
});

test('DELETE /recipes/:id leaves a database failure that is not an FK refusal alone', async () => {
  const db = new FakeDb({
    'select:recipes': [[{ id: RECIPE_ID, storagePath: STORAGE_PATH }]],
  });
  db.failOn('delete', 'recipes', Object.assign(new Error('connection terminated'), { code: 'XX000' }));
  const app = await buildCatalogApp();
  const deleted: string[] = [];
  app.use({ db: db as never, deleteObject: async (key) => { deleted.push(key); } });

  try {
    const response = await app.app.inject({ method: 'DELETE', url: `/api/v1/recipes/${RECIPE_ID}` });

    assert.equal(response.statusCode, 500);
    assert.equal((response.json() as any).error.code, 'INTERNAL_ERROR');
    assert.deepEqual(db.callsTo('update', 'recipes'), [], 'an unrelated failure must not deactivate');
    assert.deepEqual(deleted, [], 'the row still exists, so its object stays');
  } finally {
    await app.close();
  }
});

test('DELETE /recipes/:id reads a recipe this shop does not own as 404', async () => {
  const h = await harness({ 'select:recipes': [[]] });
  try {
    const { status, body } = await h.del(`/api/v1/recipes/${RECIPE_ID}`);

    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.deepEqual(h.db.callsTo('delete', 'recipes'), []);
    assert.deepEqual(h.db.callsTo('update', 'recipes'), []);
    assert.deepEqual(h.deleted, []);
  } finally {
    await h.close();
  }
});

test('DELETE /recipes/:id keeps the deactivation when the object cleanup fails', async () => {
  const db = new FakeDb({
    'select:recipes': [[{ id: RECIPE_ID, storagePath: STORAGE_PATH }]],
    'update:recipes': [[{ id: RECIPE_ID }]],
  });
  db.failOn('delete', 'recipes', foreignKeyViolation());
  const app = await buildCatalogApp();
  const deleted: string[] = [];
  app.use({
    db: db as never,
    deleteObject: async (key) => {
      deleted.push(key);
      throw new Error('R2 unreachable');
    },
  });

  try {
    const response = await app.app.inject({ method: 'DELETE', url: `/api/v1/recipes/${RECIPE_ID}` });

    // The recipe is already deactivated: reporting a failure would only invite a
    // retry that then 404s, while the leaked object stays either way.
    assert.equal(response.statusCode, 200, 'an unreachable bucket must not resurrect the recipe');
    assert.equal((response.json() as any).mode, 'soft');
    assert.deepEqual(deleted, [STORAGE_PATH], 'the cleanup was attempted');
    assert.equal(db.callsTo('update', 'recipes').length, 1);
  } finally {
    await app.close();
  }
});

test('the fallback exists because order lines restrict a recipe delete', () => {
  // Order lines are sales history: this refusal is the signal `23503`, and the
  // try-hard branch depends on it arriving.
  assert.equal(onDeleteOf(orderItems, 'recipe_id'), 'restrict');
  // Recipe lines are not history — a hard delete takes them with the row, so a
  // recipe that was never ordered can be removed in one statement.
  assert.equal(onDeleteOf(recipeIngredients, 'recipe_id'), 'cascade');
});

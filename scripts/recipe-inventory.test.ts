import assert from 'node:assert/strict';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { resolveRecipeInventoryLinks } from '../src/lib/recipeInventory.js';

const rows = [
  ['b', 'Descriptive flour', ' Wheat   FLOUR ', 'shop-a'],
  ['a', 'Other brand', 'wheat flour', 'shop-a'],
  ['c', '  RAW flour ', 'unrelated', 'shop-a'],
  ['d', 'Foreign only', 'foreign material', 'shop-b'],
  ['e', '', '', 'shop-a'],
];

test('recipe matching is exact, normalized, material-first, deterministic and shop scoped', async () => {
  for (const candidates of [rows, [...rows].reverse()]) {
    const db = drizzle(async (sql, params) => {
      assert.match(sql, /where "inventory_items"\."shop_id" = \$1/);
      assert.deepEqual(params, ['shop-a']);
      return { rows: candidates.filter(row => row[3] === params[0]).map(row => row.slice(0, 3)) };
    });
    const links = await resolveRecipeInventoryLinks(db, 'shop-a', [
      { rawMaterialName: 'wheat flour', rawName: 'raw flour' },
      { rawMaterialName: 'missing', rawName: ' RAW\tflour ' },
      { rawMaterialName: 'foreign material', rawName: 'Foreign only' },
      { rawMaterialName: ' ', rawName: '\t' },
      { rawName: 'raw flour' },
      { rawMaterialName: 'wheat', rawName: 'flour' },
      { rawMaterialName: 'wheat flour', rawName: 'different line' },
    ]);
    assert.deepEqual(links, ['a', 'c', null, null, 'c', null, 'a']);
  }
});

// Use a dedicated test URL only. Temporary tables shadow production names and
// disappear on commit; this test never applies a migration to application tables.
const databaseUrl = process.env.RECIPE_CONTRACT_TEST_DATABASE_URL;
test('repeated recipe lines survive the migration without merging amounts or units', { skip: !databaseUrl && 'requires RECIPE_CONTRACT_TEST_DATABASE_URL' }, async () => {
  const { default: postgres } = await import('postgres');
  const { readFileSync } = await import('node:fs');
  const connection = postgres(databaseUrl!, { max: 1 });
  try {
    await connection.begin(async tx => {
      await tx.unsafe(`CREATE TEMP TABLE recipe_ingredients (
        id integer PRIMARY KEY, recipe_id integer, inventory_item_id integer,
        raw_name text, quantity numeric(12,3), raw_src_unit text
      ) ON COMMIT DROP;
      CREATE UNIQUE INDEX recipe_ingredients_recipe_id_inventory_item_id_unique ON recipe_ingredients(recipe_id, inventory_item_id);
      CREATE UNIQUE INDEX recipe_ingredients_recipe_id_raw_name_unique ON recipe_ingredients(recipe_id, raw_name);
      INSERT INTO recipe_ingredients VALUES (1, 1, 1, 'Flour', 100, 'g');`);
      const migration = readFileSync(new URL('../drizzle/0026_recipe_repeated_lines.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) await tx.unsafe(statement);
      await tx.unsafe(`INSERT INTO recipe_ingredients VALUES
        (2, 1, 1, 'Flour', 2, 'kg'), (3, 1, NULL, 'Unknown', 1, 'cup'), (4, 1, NULL, 'Unknown', 3, 'g');`);
      const lines = await tx`SELECT quantity, raw_src_unit FROM recipe_ingredients ORDER BY id`;
      assert.deepEqual(Array.from(lines), [
        { quantity: '100.000', raw_src_unit: 'g' }, { quantity: '2.000', raw_src_unit: 'kg' },
        { quantity: '1.000', raw_src_unit: 'cup' }, { quantity: '3.000', raw_src_unit: 'g' },
      ]);
    });
  } finally { await connection.end(); }
});

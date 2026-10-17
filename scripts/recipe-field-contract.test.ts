import './support/testEnv.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postgres from 'postgres';
import { parseRecipeExtraction, RECIPE_SCHEMA } from '../src/lib/gemini.js';
import { generalPrices, recipeIngredients } from '../src/db/schema/catalog.js';
import { getTableConfig } from 'drizzle-orm/pg-core';

// Explicit disposable database only; never migrate a developer or shared database.
const databaseUrl = process.env.RECIPE_CONTRACT_TEST_DATABASE_URL;
test('recipe extraction schema is valid JSON and preserves ordered steps and renamed fields', () => {
  const schema = JSON.parse(RECIPE_SCHEMA);
  assert.ok(schema.properties.steps);
  assert.equal(schema.properties.instructions, undefined);
  const recipe = parseRecipeExtraction({
    name: 'Bread', steps: [{ stepNumber: 1, instruction: 'Mix 1.5 kg flour.' }, { stepNumber: 2, instruction: '<b>Bake</b>' }],
    ingredients: [{ rawName: '2 cups flour', rawMaterialName: 'flour', rawSrcUnit: 'cups', quantity: '2' }],
  });
  assert.deepEqual(recipe.steps, [{ stepNumber: 1, instruction: 'Mix 1.5 kg flour.' }, { stepNumber: 2, instruction: 'Bake' }]);
  assert.deepEqual(recipe.ingredients[0], { rawName: '2 cups flour', rawMaterialName: 'flour', rawSrcUnit: 'cups', quantity: 2, baseUnit: null, baseUnitAmount: null });
  assert.deepEqual(parseRecipeExtraction({}).steps, []);
});

test('general prices expose only the agreed columns and receipt-compatible decimals', () => {
  const columns = getTableConfig(generalPrices).columns;
  assert.deepEqual(columns.map((column) => column.name).sort(), [
    'id', 'created_at', 'raw_name', 'sku', 'raw_material_name', 'raw_src_unit', 'src_unit', 'base_unit', 'base_unit_amount', 'base_unit_cost',
  ].sort());
  assert.equal(generalPrices.baseUnitAmount.getSQLType(), 'numeric(24, 3)');
  assert.equal(recipeIngredients.baseUnitAmount.getSQLType(), 'numeric(24, 3)');
  assert.equal(generalPrices.baseUnitCost.getSQLType(), 'numeric(18, 6)');
  assert.equal(generalPrices.baseUnitCost.notNull, false);
});

test('forward migration preserves IDs, references, instructions and only proven conversions', { skip: !databaseUrl && 'requires RECIPE_CONTRACT_TEST_DATABASE_URL' }, async () => {
  const connection = postgres(databaseUrl!, { max: 1 });
  try {
    await connection.begin(async (tx) => {
      await tx.unsafe(`
        CREATE TEMP TABLE general_prices (
          id uuid PRIMARY KEY, created_at timestamptz DEFAULT now() NOT NULL,
          normalized_name text NOT NULL, barcode text, name text NOT NULL,
          manufacturer text, chain text, price_ils numeric(12,2), package_quantity numeric(12,3),
          package_unit text, price_per_base_unit numeric(12,4), source_url text, fetched_at timestamptz, updated_at timestamptz
        ) ON COMMIT DROP;
        CREATE UNIQUE INDEX general_prices_normalized_name_unique ON general_prices(normalized_name);
        CREATE INDEX general_prices_barcode_idx ON general_prices(barcode);
        CREATE TEMP TABLE recipes (id integer PRIMARY KEY, instructions text) ON COMMIT DROP;
        CREATE TEMP TABLE recipe_ingredients (
          id integer PRIMARY KEY, recipe_id integer REFERENCES recipes(id), raw_name text,
          search_able_name text, unit text, quantity numeric(12,3), inventory_item_id uuid,
          general_price_id uuid REFERENCES general_prices(id)
        ) ON COMMIT DROP;
        INSERT INTO recipes VALUES (1, E'1. Mix 1.5 kg.\n2. Bake.'), (2, NULL);
        INSERT INTO general_prices(id, normalized_name, barcode, name, price_ils, package_quantity, package_unit, price_per_base_unit) VALUES
          ('00000000-0000-4000-8000-000000000001', 'flour', '123', 'Flour', 6, 0.5, 'kg', 999),
          ('00000000-0000-4000-8000-000000000002', 'milk', '456', 'Milk', 6, NULL, NULL, 6);
        INSERT INTO recipe_ingredients VALUES
          (1, 1, 'two kg flour', 'flour', 'kg', 2, NULL, '00000000-0000-4000-8000-000000000001'),
          (2, 1, 'cup milk', 'milk', 'cup', 1, NULL, '00000000-0000-4000-8000-000000000002');
      `);
      const migration = readFileSync(new URL('../drizzle/0025_recipe_field_contract.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) await tx.unsafe(statement);
      const lines = await tx`SELECT * FROM recipe_ingredients ORDER BY id`;
      assert.equal(lines[0]?.id, 1);
      assert.equal(lines[0]?.raw_name, 'two kg flour');
      assert.equal(lines[0]?.general_price_id, '00000000-0000-4000-8000-000000000001');
      assert.equal(lines[0]?.base_unit_amount, '2000.000');
      assert.equal(lines[1]?.base_unit, null);
      assert.equal(lines[1]?.base_unit_amount, null);
      const steps = await tx`SELECT steps FROM recipes ORDER BY id`;
      assert.deepEqual(steps[0]?.steps, [{ stepNumber: 1, instruction: '1. Mix 1.5 kg.\n2. Bake.' }]);
      assert.deepEqual(steps[1]?.steps, []);
      const prices = await tx`SELECT * FROM general_prices ORDER BY id`;
      assert.equal(prices[0]?.base_unit_cost, '0.012000');
      assert.equal(prices[0]?.base_unit_amount, '500.000');
      assert.equal(prices[1]?.base_unit_cost, null);
      // Same SKU for another material query is distinct; repeated identities upsert.
      await tx`INSERT INTO general_prices(id, raw_name, raw_material_name, sku) VALUES ('00000000-0000-4000-8000-000000000003', 'Flour', 'white flour', '123')`;
      await tx`INSERT INTO general_prices(id, raw_name, raw_material_name, sku) VALUES ('00000000-0000-4000-8000-000000000004', 'Updated flour', 'flour', '123') ON CONFLICT (raw_material_name, sku) DO UPDATE SET raw_name = excluded.raw_name`;
      const updated = await tx`SELECT id, raw_name FROM general_prices WHERE raw_material_name = 'flour'`;
      assert.equal(updated[0]?.id, prices[0]?.id);
      assert.equal(updated[0]?.raw_name, 'Updated flour');
      const columns = await tx`SELECT column_name FROM information_schema.columns WHERE table_name = 'general_prices' AND table_schema LIKE 'pg_temp_%'`;
      assert.equal(columns.length, 10);
    });
  } finally { await connection.end(); }
});

import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';

test('finished stock belongs to a saved line and legacy cancellations keep an unknown decision', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const db = postgres(testDatabaseUrl!);
  try {
    await db.begin(async tx => {
      const shop = randomUUID();
      const other = randomUUID();
      const order = randomUUID();
      const recipe = randomUUID();
      const otherRecipe = randomUUID();
      const line = randomUUID();
      const crossShopLine = randomUUID();
      await tx`INSERT INTO shops (id, name, slug) VALUES (${shop}, 'Stock', ${shop}), (${other}, 'Other', ${other})`;
      const [legacy] = await tx`INSERT INTO orders (id, shop_id, order_number, status) VALUES (${order}, ${shop}, 1, 'cancelled')
        RETURNING cancellation_made_items, cancelled_at, cancelled_by_user_id`;
      assert.deepEqual(legacy, { cancellation_made_items: null, cancelled_at: null, cancelled_by_user_id: null });
      await tx`INSERT INTO recipes (id, shop_id, name) VALUES (${recipe}, ${shop}, 'Bread'), (${otherRecipe}, ${other}, 'Cake')`;
      await tx`INSERT INTO order_items (id, shop_id, order_id, recipe_id, quantity) VALUES
        (${line}, ${shop}, ${order}, ${recipe}, 3.75), (${crossShopLine}, ${other}, ${order}, ${otherRecipe}, 3)`;
      const addStock = (source: string, shopId: string, recipeId: string, added: number, remaining: number) => tx.savepoint(save => save`
        INSERT INTO finished_stock (shop_id, recipe_id, source_order_item_id, quantity_added, quantity_remaining, unit_cost)
        VALUES (${shopId}, ${recipeId}, ${source}, ${added}, ${remaining}, 12.34) RETURNING quantity_remaining, cost_complete`);
      await assert.rejects(addStock(line, shop, recipe, 3, 4), { code: '23514' });
      await assert.rejects(addStock(line, shop, recipe, 0, 0), { code: '23514' });
      await assert.rejects(addStock(line, shop, otherRecipe, 1, 1), { code: '23503' });
      await assert.rejects(addStock(crossShopLine, other, otherRecipe, 1, 1), { code: '23503' });
      const [stock] = await addStock(line, shop, recipe, 3, 3);
      assert.deepEqual(stock, { quantity_remaining: 3, cost_complete: null });
      await assert.rejects(addStock(line, shop, recipe, 1, 1), { code: '23505' });
      await assert.rejects(tx.savepoint(save => save`DELETE FROM order_items WHERE id = ${line}`),
        { constraint_name: 'finished_stock_source_line_fk' });

      await tx`DELETE FROM finished_stock WHERE shop_id = ${shop}`;
      await tx`DELETE FROM order_items WHERE id IN (${line}, ${crossShopLine})`;
      await tx`DELETE FROM shops WHERE id IN (${shop}, ${other})`;
    });
  } finally {
    await db.end();
  }
});

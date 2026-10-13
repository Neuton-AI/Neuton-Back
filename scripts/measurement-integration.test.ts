import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq, sql as query } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { inventoryItems, receiptItems, receipts, profiles, recipes, recipeIngredients, shops, orderItems, orders } from '../src/db/schema/index.js';
import { verifyReceipt } from '../src/lib/verifyReceipt.js';
import { costRecipe } from '../src/lib/recipeCosting.js';
import { priceOrderItems } from '../src/routes/orders.js';
import { processOrderDocument } from '../src/worker.js';
import type { WorkerDeps } from '../src/worker.js';
import type { Job } from 'bullmq';
import type { MediaJobData } from '../src/lib/queue.js';

const skip = !process.env.NEUTON_TEST_DATABASE_URL && 'Requires an isolated local NEUTON_TEST_DATABASE_URL';
test('Postgres: deferred receipts apply exactly once, purchases serialize, and all three costing paths agree', { skip }, async () => {
  const shopId = randomUUID(), userId = randomUUID();
  try {
    await db.execute(query`insert into auth.users(id,email) values (${userId}, 'n136-local@example.com')`);
    await db.insert(profiles).values({ id: userId });
    await db.insert(shops).values({ id: shopId, name: 'N136 isolated integration', slug: 'n136-' + shopId, currency: 'ILS', hourlyLaborCost: '0', targetProfitMargin: '0' });
    const [item] = await db.insert(inventoryItems).values({ shopId, name: 'butter', unit: 'g', currentQuantity: '0', averageUnitCost: null }).returning();
    async function purchase(quantity: number, unit: string, unitPrice: number, totalPrice: number) {
      const [receipt] = await db.insert(receipts).values({ shopId, storagePath: 'local-fixture/' + randomUUID(), status: 'unverified', currency: 'ILS' }).returning();
      const [line] = await db.insert(receiptItems).values({ shopId, receiptId: receipt!.id, rawName: 'butter', quantity: String(quantity), unit, unitPrice: String(unitPrice), totalPrice: String(totalPrice) }).returning();
      return { receipt: receipt!, line: line! };
    }
    const unknown = await purchase(2, 'pack', 10, 20);
    const pending = await verifyReceipt({ db, shopId, userId, receiptId: unknown.receipt.id, lookup: async () => null, items: [{ id: unknown.line.id, accepted: true }] });
    assert.equal(pending.pending, 1);
    assert.equal((await db.select().from(inventoryItems).where(eq(inventoryItems.id, item!.id)))[0]?.currentQuantity, '0.000000');
    const resolve = () => verifyReceipt({ db, shopId, userId, receiptId: unknown.receipt.id, deferred: true, lookup: async () => null,
      items: [{ id: unknown.line.id, accepted: true, packageQuantity: 250, packageUnit: 'g' }] });
    const raced = await Promise.allSettled([resolve(), resolve()]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    const [balance] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item!.id));
    assert.equal(balance?.currentQuantity, '500.000000');
    assert.equal(balance?.averageUnitCost, '0.0400000000');
    const [recipe] = await db.insert(recipes).values({ shopId, name: '50g butter', prepTimeMinutes: 0, yieldQuantity: '1', status: 'verified' }).returning();
    await db.insert(recipeIngredients).values({ shopId, recipeId: recipe!.id, inventoryItemId: item!.id, rawName: 'butter', searchAbleName: 'butter', quantity: '50', unit: 'g' });
    assert.equal((await costRecipe(shopId, recipe!, '0', '0')).unitCost, 2);
    const quote = await priceOrderItems(db, shopId, '0', '0', [{ recipeId: recipe!.id, quantity: 1 }]);
    assert.equal(quote[0]?.unitCost, 2);
    const [order] = await db.insert(orders).values({ shopId, orderNumber: 1, status: 'processing', totalCost: null }).returning();
    const data: MediaJobData = { shopId, kind: 'order', orderId: order!.id, storagePath: 'local', contentType: 'image/png', uploadedBy: userId, originalFilename: null };
    const deps: WorkerDeps = { db, getObjectBytes: async () => new Uint8Array(), extractOrder: async () => ({ customerName: null, destinationAddress: null, items: [{ name: recipe!.name, quantity: 1, unitPrice: null }] }), extractReceipt: async () => null, extractRecipe: async () => null, searchProduct: async () => [] };
    await processOrderDocument(deps, data, { id: 'local', updateProgress: async () => {} } as unknown as Job<MediaJobData>);
    const [orderLine] = await db.select().from(orderItems).where(eq(orderItems.orderId, order!.id));
    assert.equal(Number(orderLine?.unitCost), 2);
    assert.ok(orderLine?.costingSnapshot);
    await db.update(orders).set({ status: 'delivered' }).where(eq(orders.id, order!.id));
    await db.update(inventoryItems).set({ averageUnitCost: '.08' }).where(eq(inventoryItems.id, item!.id));
    await processOrderDocument(deps, data, { id: 'late', updateProgress: async () => {} } as unknown as Job<MediaJobData>);
    assert.equal(Number((await db.select().from(orderItems).where(eq(orderItems.orderId, order!.id)))[0]?.unitCost), 2);
    await db.update(inventoryItems).set({ currentQuantity: '0', averageUnitCost: null }).where(eq(inventoryItems.id, item!.id));
    const a = await purchase(1, 'kg', 20, 20), b = await purchase(500, 'g', .03, 15);
    await Promise.all([a, b].map(p => verifyReceipt({ db, shopId, userId, receiptId: p.receipt.id, lookup: async () => null, items: [{ id: p.line.id, accepted: true }] })));
    const [mixed] = await db.select().from(inventoryItems).where(eq(inventoryItems.id, item!.id));
    assert.equal(Number(mixed?.currentQuantity), 1500);
    assert.ok(Math.abs(Number(mixed?.averageUnitCost) * 1500 - 35) < 1e-6);
  } finally {
    await db.delete(shops).where(eq(shops.id, shopId));
    await db.delete(profiles).where(eq(profiles.id, userId));
    await db.execute(query`delete from auth.users where id = ${userId}`);
  }
});
test.after(async () => { await sql.end({ timeout: 1 }); });

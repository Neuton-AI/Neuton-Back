import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq, sql as query } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { inventoryItems, receiptItems, receipts, profiles, recipes, recipeIngredients, shops, orderItems, orders, productMeasurements, generalPrices } from '../src/db/schema/index.js';
import { verifyReceipt } from '../src/lib/verifyReceipt.js';
import { costRecipe } from '../src/lib/recipeCosting.js';
import { priceOrderItems } from '../src/routes/orders.js';
import { processOrderDocument } from '../src/worker.js';
import type { WorkerDeps } from '../src/worker.js';
import type { Job } from 'bullmq';
import type { MediaJobData } from '../src/lib/queue.js';

const skip = !process.env.NEUTON_TEST_DATABASE_URL && 'Requires an isolated local NEUTON_TEST_DATABASE_URL';
test('Postgres: deferred receipts apply exactly once, purchases serialize, and all three costing paths agree', { skip }, async () => {
  const shopId = randomUUID(), userId = randomUUID(), otherShopId = randomUUID(), offerId = randomUUID();
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

    // A saved multipack applies to this shop/product and is reusable by receipt
    // and catalog costing. It never changes the global price source or stock.
    await db.insert(productMeasurements).values({ shopId, productKey: 'carrefour:12345678', packageQuantity: '250', packageUnit: 'g', packagesPerPurchase: '2', evidence: { source: 'user' } });
    const reused = await purchase(2, 'pack', 7, 14);
    await db.update(receiptItems).set({ rawSku: '12345678', codeChain: 'carrefour' }).where(eq(receiptItems.id, reused.line.id));
    await verifyReceipt({ db, shopId, userId, receiptId: reused.receipt.id, lookup: async () => null, items: [{ id: reused.line.id, accepted: true }] });
    const [reusedLine] = await db.select().from(receiptItems).where(eq(receiptItems.id, reused.line.id));
    assert.equal(Number(reusedLine?.normalizedQuantity), 1000);
    assert.equal(Number(reusedLine?.normalizedRate), .014);
    await db.insert(generalPrices).values({ id: offerId, offerKey: 'n136:' + offerId, normalizedName: 'butter', name: 'butter', barcode: '12345678', chain: 'carrefour', priceIls: '14', fetchedAt: new Date(), measurementStatus: 'unresolved' });
    await db.insert(shops).values({ id: otherShopId, name: 'Other shop', slug: 'n136-other-' + otherShopId, currency: 'ILS' });
    for (const [scope, expected] of [[shopId, 1.4], [otherShopId, null]] as const) {
      const [publicRecipe] = await db.insert(recipes).values({ shopId: scope, name: 'Scoped public butter', yieldQuantity: '1', prepTimeMinutes: 0 }).returning();
      await db.insert(recipeIngredients).values({ shopId: scope, recipeId: publicRecipe!.id, rawName: 'butter', searchAbleName: 'butter', quantity: '50', unit: 'g', generalPriceId: offerId });
      const priced = await costRecipe(scope, publicRecipe!, '0', '0');
      assert.equal(priced.unitCost, expected);
      assert.equal(priced.inStock, false);
    }
    // Opposite receipt ordering must not deadlock during new-item creation.
    async function newProducts(names: string[]) {
      const [receipt] = await db.insert(receipts).values({ shopId, storagePath: 'local-fixture/' + randomUUID(), status: 'unverified', currency: 'ILS' }).returning();
      const lines = await db.insert(receiptItems).values(names.map(rawName => ({ shopId, receiptId: receipt!.id, rawName, quantity: '100', unit: 'g', unitPrice: '.01', totalPrice: '1' }))).returning();
      return verifyReceipt({ db, shopId, userId, receiptId: receipt!.id, lookup: async () => null, items: lines.map(line => ({ id: line.id, accepted: true })) });
    }
    const created = await Promise.all([newProducts(['flour', 'sugar']), newProducts(['sugar', 'flour'])]);
    assert.ok(created.every(result => result.applied === 2));
  } finally {
    await db.delete(shops).where(eq(shops.id, shopId));
    await db.delete(shops).where(eq(shops.id, otherShopId));
    await db.delete(generalPrices).where(eq(generalPrices.id, offerId));
    await db.delete(profiles).where(eq(profiles.id, userId));
    await db.execute(query`delete from auth.users where id = ${userId}`);
  }
});
test.after(async () => { await sql.end({ timeout: 1 }); });

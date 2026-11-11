import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import postgres from 'postgres';
import type { MediaJobData } from '../src/lib/queue.js';

const origin = 'https://app.example.test';
process.env.APP_ORIGIN = origin;
delete process.env.GOOGLE_CLIENT_ID;

type Browser = { cookie: string; proof: string };

function cookieFrom(response: request.Response, name: string) {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find((value) => value.startsWith(name + '='));
  assert.ok(cookie, 'Expected a cookie');
  return cookie.split(';')[0]!;
}

test('a deleted shop stops a media job before it reads or writes the document', async () => {
  const { processRecipe } = await import('../src/modules/processing/processing.service.js');
  let extracted = false;
  const chain = {
    from() { return chain; },
    where() { return chain; },
    async limit() { return []; },
  };
  const data = {
    shopId: randomUUID(),
    uploadedBy: null,
    kind: 'recipe',
    storagePath: 'shop/recipes/late.jpg',
    contentType: 'image/jpeg',
    originalFilename: null,
  } satisfies MediaJobData;
  await processRecipe({
    db: { select: () => chain } as never,
    getObjectBytes: async () => { throw new Error('read'); },
    extractReceipt: async () => { throw new Error('read'); },
    extractRecipe: async () => { extracted = true; throw new Error('read'); },
    extractOrder: async () => { throw new Error('read'); },
    searchProduct: async () => [],
  }, data, { updateProgress: async () => undefined });
  assert.equal(extracted, false);
});

test('owner delete removes one shop and refuses everyone else', {
  skip: skipWithoutDisposableDatabase,
  timeout: 30000,
}, async () => {
  const { AppModule } = await import('../src/app.js');
  const { SyncEvents } = await import('../src/modules/sync/sync-events.js');
  const { testApplication } = await import('./support/httpClient.js');
  const connection = postgres(testDatabaseUrl!);
  const app = await testApplication(AppModule, [], { origins: [origin] });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const password = 'testpass10';
  const getProof = (cookie = '') => api.post('/api/v1/auth/csrf').set({ Origin: origin, Cookie: cookie });
  async function browser() {
    const context = await getProof();
    assert.equal(context.status, 200);
    return { cookie: cookieFrom(context, '__Host-neuton-context'), proof: context.body.token as string };
  }
  async function account(name: string) {
    const guest = await browser();
    const created = await api.post('/api/v1/auth/signup').set({
      Origin: origin, Cookie: guest.cookie, 'X-CSRF-Token': guest.proof,
    }).send({ email: `${name}-${randomUUID()}@example.test`, password, fullName: name });
    assert.equal(created.status, 201);
    const cookie = cookieFrom(created, '__Host-neuton-session');
    const proof = await getProof(cookie);
    return { cookie, proof: proof.body.token as string, id: created.body.user.id as string };
  }
  const headers = (actor: Browser) => ({ Origin: origin, Cookie: actor.cookie, 'X-CSRF-Token': actor.proof });
  const remove = (actor: Browser, shopId: string, name: unknown) =>
    api.delete(`/api/v1/shops/${shopId}`).set(headers(actor)).send({ name });
  try {
    const owner = await account('owner');
    const admin = await account('admin');
    const stranger = await account('stranger');
    const kept = await api.post('/api/v1/shops').set(headers(owner)).send({ name: 'Kept Shop' });
    const doomed = await api.post('/api/v1/shops').set(headers(owner)).send({ name: 'Doomed Shop' });
    const broken = await api.post('/api/v1/shops').set(headers(owner)).send({ name: 'Broken Shop' });
    assert.equal(kept.status, 201);
    assert.equal(doomed.status, 201);
    assert.equal(broken.status, 201);
    const shopId = doomed.body.shop.id as string;
    const keptId = kept.body.shop.id as string;
    const brokenId = broken.body.shop.id as string;
    const recipeId = randomUUID();
    const inventoryId = randomUUID();
    const path = `${shopId}/recipes/bread.jpg`;
    await connection`INSERT INTO shop_members (shop_id, user_id, role) VALUES (${shopId}, ${admin.id}, 'admin')`;
    await connection`INSERT INTO categories (shop_id, name) VALUES (${shopId}, 'Produce')`;
    await connection`INSERT INTO inventory_items (shop_id, name, raw_material_name, unit, base_unit, base_unit_amount, base_unit_cost)
      VALUES (${shopId}, 'Flour', 'Flour', 'kg', 'g', 1000, 1)`;
    await connection`INSERT INTO recipes (shop_id, name, storage_path) VALUES (${shopId}, 'Bread', ${path})`;
    const [recipe] = await connection<{ id: string }[]>`SELECT id FROM recipes WHERE shop_id = ${shopId}`;
    const [inventory] = await connection<{ id: string }[]>`SELECT id FROM inventory_items WHERE shop_id = ${shopId}`;
    assert.ok(recipe && inventory);
    await connection`INSERT INTO recipe_ingredients (shop_id, recipe_id, inventory_item_id, raw_name, raw_material_name, quantity, raw_src_unit)
      VALUES (${shopId}, ${recipe.id}, ${inventory.id}, 'Flour', 'Flour', 1, 'kg')`;
    await connection`INSERT INTO orders (shop_id, order_number) VALUES (${shopId}, 1)`;
    const [order] = await connection<{ id: string }[]>`SELECT id FROM orders WHERE shop_id = ${shopId}`;
    assert.ok(order);
    await connection`INSERT INTO order_items (shop_id, order_id, recipe_id) VALUES (${shopId}, ${order.id}, ${recipe.id})`;
    await connection`INSERT INTO receipts (shop_id, storage_path) VALUES (${shopId}, ${`${shopId}/receipts/note.jpg`})`;
    await connection`INSERT INTO media_uploads (shop_id, kind, sources) VALUES (${shopId}, 'recipe', ${connection.json([{
      sourceId: randomUUID(), storagePath: path, contentType: 'image/jpeg', originalFilename: null, byteSize: 4,
    }])})`;
    await connection`INSERT INTO document_versions (shop_id, kind, id, updated_at) VALUES (${shopId}, 'recipe', ${recipeId}, 1)`;
    await connection`INSERT INTO document_mutations (shop_id, id, user_id, request) VALUES (${shopId}, ${randomUUID()}, ${owner.id}, '{}')`;
    await connection`INSERT INTO audit_logs (shop_id, event_type) VALUES (${shopId}, 'SHOP_CREATED')`;
    await connection`INSERT INTO inventory_adjustment_batches (shop_id, id, user_id, request_hash) VALUES (${shopId}, ${inventoryId}, ${owner.id}, 'hash')`;
    await connection`INSERT INTO general_prices (raw_name, raw_material_name) VALUES ('Shared flour', 'Flour')`;
    await connection`INSERT INTO recipes (shop_id, name, storage_path) VALUES (${brokenId}, 'Outside', 'outside/path.jpg')`;

    assert.equal((await api.delete(`/api/v1/shops/${shopId}`).send({ name: 'Doomed Shop' })).status, 401);
    const mismatch = await remove(owner, shopId, 'doomed shop');
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.message, 'The shop name does not match.');
    assert.equal(JSON.stringify(mismatch.body).includes('doomed shop'), false);
    assert.equal((await remove(admin, shopId, 'Doomed Shop')).status, 403);
    assert.equal((await remove(stranger, shopId, 'Doomed Shop')).status, 404);
    assert.equal((await remove(owner, randomUUID(), 'Doomed Shop')).status, 404);
    const failed = await remove(owner, brokenId, 'Broken Shop');
    assert.equal(failed.status, 500);
    assert.equal((await connection`SELECT count(*)::int AS n FROM shops WHERE id = ${brokenId}`)[0]?.n, 1);
    assert.equal((await connection`SELECT count(*)::int AS n FROM storage_object_deletions WHERE shop_id = ${brokenId}`)[0]?.n, 0);

    const events = app.get(SyncEvents);
    let removed = false;
    let other = false;
    const stopRemoved = events.subscribe(shopId, (event) => { if (event === 'removed') removed = true; });
    const stopOther = events.subscribe(keptId, () => { other = true; });
    const deleted = await remove(owner, shopId, 'Doomed Shop');
    stopRemoved();
    stopOther();
    assert.equal(deleted.status, 204);
    assert.equal(deleted.headers['cache-control'], 'no-store');
    assert.equal(deleted.text, '');
    assert.equal(removed, true);
    assert.equal(other, false);
    assert.equal((await remove(owner, shopId, 'Doomed Shop')).status, 404);
    assert.equal((await api.get('/api/v1/sync/events').set({ Cookie: owner.cookie, 'x-shop-id': shopId })).status, 403);
    assert.equal((await connection`SELECT count(*)::int AS n FROM shops WHERE id = ${shopId}`)[0]?.n, 0);
    assert.equal((await connection`SELECT count(*)::int AS n FROM shop_members WHERE shop_id = ${shopId}`)[0]?.n, 0);
    assert.equal((await connection`SELECT count(*)::int AS n FROM recipes WHERE shop_id = ${shopId}`)[0]?.n, 0);
    assert.equal((await connection`SELECT count(*)::int AS n FROM orders WHERE shop_id = ${shopId}`)[0]?.n, 0);
    assert.equal((await connection`SELECT count(*)::int AS n FROM storage_object_deletions WHERE shop_id = ${shopId}`)[0]?.n, 3);
    assert.equal((await connection`SELECT count(*)::int AS n FROM shops WHERE id = ${keptId}`)[0]?.n, 1);
    assert.equal((await connection`SELECT count(*)::int AS n FROM users WHERE id = ${owner.id}`)[0]?.n, 1);
    assert.equal((await connection`SELECT count(*)::int AS n FROM general_prices WHERE raw_name = 'Shared flour'`)[0]?.n, 1);
    const session = await api.get('/api/v1/session').set('Cookie', owner.cookie);
    assert.equal(session.body.memberships.length, 2);

    const second = await account('second-owner');
    await connection`INSERT INTO shop_members (shop_id, user_id, role) VALUES (${keptId}, ${second.id}, 'owner')`;
    const race = await Promise.all([
      remove(owner, keptId, 'Kept Shop'),
      remove(second, keptId, 'Kept Shop'),
    ]);
    assert.deepEqual(race.map((result) => result.status).sort(), [204, 404]);
    assert.equal((await connection`SELECT count(*)::int AS n FROM shops WHERE id = ${keptId}`)[0]?.n, 0);
  } finally {
    await app.close();
    await connection.end({ timeout: 5 });
  }
});

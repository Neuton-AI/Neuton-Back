import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/db/schema/index.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../src/modules/shops/contracts.js';
import { generateUniqueSlug } from '../src/lib/slug.js';
const url = testDatabaseUrl;
test(
  'onboarding rolls shop and owner back together and renamed slugs exclude only their own shop',
  {
    skip: skipWithoutDisposableDatabase,
    timeout: 20000,
  },
  async () => {
    const namespace = `shops_${randomUUID().replaceAll('-', '')}`;
    const connection = postgres(url!, {
      max: 2,
      onnotice() {},
      connection: { search_path: namespace },
    });
    const userId = randomUUID();
    try {
      await connection.unsafe(
        `CREATE SCHEMA ${namespace};CREATE TABLE ${namespace}.users(LIKE public.users INCLUDING ALL);CREATE TABLE ${namespace}.shops(LIKE public.shops INCLUDING ALL);CREATE TABLE ${namespace}.shop_members(LIKE public.shop_members INCLUDING ALL);ALTER TABLE ${namespace}.shop_members ADD FOREIGN KEY (user_id) REFERENCES ${namespace}.users(id), ADD CONSTRAINT fail_owner CHECK(role <> 'owner');`,
      );
      await connection`INSERT INTO users(id, email, password_hash) VALUES (${userId}, 'owner@example.test', 'unused-fixture-hash')`;
      const database = drizzle(connection, { schema });
      const persistence = new ShopsPersistence(database);
      const body = createShopSchema.parse({ name: 'Existing' });
      await assert.rejects(persistence.create(userId, body));
      assert.equal(
        (await connection`SELECT count(*)::int as n FROM shops`)[0]?.n,
        0,
      );
      await connection.unsafe(
        'ALTER TABLE shop_members DROP CONSTRAINT fail_owner',
      );
      const first = await persistence.create(userId, body);
      const second = await persistence.create(
        userId,
        createShopSchema.parse({ name: 'Another' }),
      );
      assert.equal(first.slug, 'existing');
      assert.equal(
        await generateUniqueSlug('Existing', database, {
          excludeShopId: second.id,
        }),
        'existing-1',
      );
      assert.equal(
        await generateUniqueSlug('Existing', database, {
          excludeShopId: first.id,
        }),
        'existing',
      );
      assert.equal(
        (
          await connection`SELECT role FROM shop_members WHERE shop_id=${first.id}`
        )[0]?.role,
        'owner',
      );
    } finally {
      await connection.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await connection.end({ timeout: 5 });
    }
  },
);

import './support/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/db/schema/index.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../src/modules/shops/contracts.js';
import { generateUniqueSlug } from '../src/lib/slug.js';
const url = process.env.API_ALIGNMENT_TEST_DATABASE_URL;
test(
  'onboarding rolls profile/shop/owner back together and renamed slugs exclude only their own shop',
  {
    skip: !url && 'requires disposable API_ALIGNMENT_TEST_DATABASE_URL',
    timeout: 20000,
  },
  async () => {
    const namespace = `shops_${randomUUID().replaceAll('-', '')}`;
    const connection = postgres(url!, {
      max: 2,
      onnotice() {},
      connection: { search_path: namespace },
    });
    const user = {
      id: randomUUID(),
      email: null,
      fullName: 'User',
      avatarUrl: null,
    };
    try {
      await connection.unsafe(
        `CREATE SCHEMA ${namespace};CREATE TABLE ${namespace}.profiles(LIKE public.profiles INCLUDING ALL);CREATE TABLE ${namespace}.shops(LIKE public.shops INCLUDING ALL);CREATE TABLE ${namespace}.shop_members(LIKE public.shop_members INCLUDING ALL);ALTER TABLE ${namespace}.shop_members ADD CONSTRAINT fail_owner CHECK(role <> 'owner');`,
      );
      const database = drizzle(connection, { schema });
      const persistence = new ShopsPersistence(database);
      const body = createShopSchema.parse({ name: 'Existing' });
      await assert.rejects(persistence.create(user, body));
      assert.equal(
        (await connection`SELECT count(*)::int as n FROM profiles`)[0]?.n,
        0,
      );
      assert.equal(
        (await connection`SELECT count(*)::int as n FROM shops`)[0]?.n,
        0,
      );
      await connection.unsafe(
        'ALTER TABLE shop_members DROP CONSTRAINT fail_owner',
      );
      const first = await persistence.create(user, body);
      const second = await persistence.create(
        user,
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

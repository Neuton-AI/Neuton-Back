import { TEST_SESSION_ID, TEST_SESSION_SECRET, TEST_SESSION_COOKIE, testIdentity } from './support/authIdentity.js';
import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { digestSecret } from '../src/modules/auth/crypto.js';
import { createHttpApplication } from '../src/http/application.js';
import { IdentityModule } from '../src/modules/identity/identity.module.js';
import { ShopsController } from '../src/modules/shops/shops.controller.js';
import {
  ShopsService,
} from '../src/modules/shops/shops.service.js';
import {
  ShopsPersistence,
  SHOPS_DATABASE,
} from '../src/modules/shops/shops.persistence.js';
import { PasswordService } from '../src/modules/shops/password.service.js';
import { AnalyticsController } from '../src/modules/analytics/analytics.controller.js';
import { AnalyticsService } from '../src/modules/analytics/analytics.service.js';
import {
  AnalyticsPersistence,
  ANALYTICS_DEPS,
} from '../src/modules/analytics/analytics.persistence.js';
import { FakeDb } from './support/fakeDb.js';
import { SHOP_ID, USER_ID, TEST_SHOP } from './support/catalogApp.js';
const date = new Date('2026-01-01');
const shop = {
  ...TEST_SHOP,
  lastOrderNumber: 0,
  createdAt: date,
  updatedAt: date,
  privateColumn: 'hidden',
};
async function fixture(db: FakeDb, role = 'owner') {
  const { database, orm } = await isolatedAuthDatabase();
  await database.query(`insert into auth_private.users(id,email,normalized_email,status,email_confirmed_at)
    values($1,'test@example.test','test@example.test','active',now())`, [USER_ID]);
  await database.query('insert into public.profiles(id,full_name,created_at,updated_at) values($1,$2,$3,$3)', [USER_ID, 'User', date]);
  await database.query(`insert into auth_private.sessions(id,user_id,token_digest,csrf_digest,security_version,authenticated_at,
    authentication_method,last_activity_at,idle_expires_at,absolute_expires_at)
    values($1,$2,$3,$4,1,now(),'password',now(),now()+interval '7 days',now()+interval '30 days')`,
  [TEST_SESSION_ID, USER_ID, digestSecret('session', TEST_SESSION_SECRET), 'a'.repeat(64)]);
  await database.query(`insert into public.shops(id,name,slug,target_profit_margin,hourly_labor_cost,delivery_base_fee,delivery_rate_per_km)
    values($1,'Shop','shop',30,25,5,1.5)`, [SHOP_ID]);
  await database.query('insert into public.shop_members(shop_id,user_id,role) values($1,$2,$3)', [SHOP_ID, USER_ID, role]);
  type Transaction = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  const scopedDatabase = { transaction<T>(work: (transaction: Transaction) => Promise<T>) {
    return orm.transaction(async transaction => { await transaction.execute(sql`set local role neuton_app`); return work(transaction); });
  } };
  @Module({
    imports: [
      IdentityModule.register({
        sessionVerifier: {
          verify: async (token) =>
            token === TEST_SESSION_SECRET
              ? testIdentity(USER_ID, 'test@example.test')
              : null,
        },
        repository: {
          findProfile: async () => null,
          findMembership: async (_id, shopId) =>
            shopId === SHOP_ID ? { shopId, role: role as 'owner' } : null,
          findShop: async () => TEST_SHOP,
        },
      }),
    ],
    controllers: [ShopsController, AnalyticsController],
    providers: [
      { provide: 'PHASE_C_DATABASE', useValue: { onModuleDestroy: () => database.close() } },
      ShopsService,
      ShopsPersistence,
      PasswordService,
      AnalyticsService,
      AnalyticsPersistence,
      { provide: SHOPS_DATABASE, useValue: scopedDatabase },
      { provide: ANALYTICS_DEPS, useValue: { db, now: () => date } },
    ],
  })
  class Root {}
  const app = await createHttpApplication(Root, {
    origins: [],
    bodyLimit: 100000,
    rateLimit: { max: 1000, windowMs: 60000 },
  });
  return { app, database };
}
const headers = { cookie: TEST_SESSION_COOKIE, 'x-shop-id': SHOP_ID };
test('profile requires authentication without a selected shop and maps only public fields', async () => {
  const db = new FakeDb({
    'select:shopMembers': [
      [
        {
          role: 'owner',
          shopId: SHOP_ID,
          shopName: 'Shop',
          slug: 'shop',
          currency: 'USD',
          timezone: 'UTC',
        },
      ],
    ],
    'select:profiles': [
      [
        {
          id: USER_ID,
          fullName: 'User',
          avatarUrl: null,
          createdAt: date,
          updatedAt: date,
          secret: 'hidden',
        },
      ],
    ],
  });
  const h = await fixture(db);
  try {
    const profile = await request(h.app.getHttpServer())
      .get('/api/v1/profile')
      .set('Cookie', TEST_SESSION_COOKIE);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.createdAt, date.toISOString());
    assert.equal('secret' in profile.body.profile, false);
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .get('/api/v1/shop')
          .set('Cookie', TEST_SESSION_COOKIE)
      ).status,
      400,
    );
  } finally {
    await h.app.close();
  }
});
test('onboarding creates shop and owner in one transaction; delivery accepts only camelCase', async () => {
  const db = new FakeDb({ 'select:shops': [[]], 'insert:shops': [[shop]] });
  const h = await fixture(db);
  try {
    const response = await request(h.app.getHttpServer())
      .post('/api/v1/shops')
      .set('Cookie', TEST_SESSION_COOKIE)
      .send({ name: 'Shop' });
    assert.equal(response.status, 201);
    assert.equal(response.body.shop.targetProfitMargin, '35.00');
    assert.equal('privateColumn' in response.body.shop, false);
    assert.equal((await h.database.query<{ role: string }>('select role from public.shop_members where shop_id=$1 and user_id=$2',
      [response.body.shop.id, USER_ID])).rows[0]?.role, 'owner');
    assert.equal((await h.database.query('select id from public.audit_logs where shop_id=$1', [response.body.shop.id])).rows.length, 1);
    const preview = await request(h.app.getHttpServer())
      .get('/api/v1/shop/delivery-preview?distanceKm=2')
      .set(headers);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.deliveryFee, 8);
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .get('/api/v1/shop/delivery-preview?distance_km=2')
          .set(headers)
      ).status,
      400,
    );
  } finally {
    await h.app.close();
  }
});
test('tenant/role and password identity checks reject writes before persistence', async () => {
  const db = new FakeDb();
  const h = await fixture(db, 'member');
  try {
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .patch('/api/v1/shop')
          .set(headers)
          .send({ name: 'New' })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .get('/api/v1/analytics/dashboard')
          .set({
            ...headers,
            'x-shop-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .post('/api/v1/profile/password')
          .set('Cookie', TEST_SESSION_COOKIE)
          .send({ currentPassword: 'private', newPassword: 'private-new' })
      ).status,
      400,
    );
    assert.equal(db.calls.length, 0);
  } finally {
    await h.app.close();
  }
});

test('camelCase catalog queries reject aliases and parse false as false',async()=>{
 const {inventoryQuerySchema}=await import('../src/modules/inventory/contracts.js');
 const {recipeQuerySchema}=await import('../src/modules/recipes/contracts.js');
 assert.equal(inventoryQuerySchema.parse({includeInactive:'false'}).includeInactive,false);
 assert.equal(recipeQuerySchema.parse({includeUnverified:'true'}).includeUnverified,true);
 assert.throws(()=>inventoryQuerySchema.parse({include_inactive:'true'}));
 assert.throws(()=>recipeQuerySchema.parse({include_unverified:'true'}));
 assert.throws(()=>inventoryQuerySchema.parse({lowStockOnly:'no'}));
});

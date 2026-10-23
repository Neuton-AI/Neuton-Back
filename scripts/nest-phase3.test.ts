import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { createHttpApplication } from '../src/http/application.js';
import { IdentityModule } from '../src/modules/identity/identity.module.js';
import { ShopsController } from '../src/modules/shops/shops.controller.js';
import {
  ShopsService,
  SHOPS_AUDIT,
} from '../src/modules/shops/shops.service.js';
import {
  ShopsPersistence,
  SHOPS_DATABASE,
} from '../src/modules/shops/shops.persistence.js';
import {
  PasswordService,
  PASSWORD_CLIENT,
} from '../src/modules/shops/password.service.js';
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
async function fixture(db: FakeDb, role = 'owner', providerId = USER_ID) {
  let passwordWrites = 0;
  @Module({
    imports: [
      IdentityModule.register({
        sessionVerifier: {
          verify: async (token) =>
            token === 'test'
              ? { id: USER_ID, email: 'test@example.test' }
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
      { provide: SHOPS_AUDIT, useValue: async () => {} },
      ShopsService,
      ShopsPersistence,
      PasswordService,
      AnalyticsService,
      AnalyticsPersistence,
      { provide: SHOPS_DATABASE, useValue: db },
      { provide: ANALYTICS_DEPS, useValue: { db, now: () => date } },
      {
        provide: PASSWORD_CLIENT,
        useValue: {
          auth: {
            signInWithPassword: async () => ({
              data: { user: { id: providerId } },
              error: null,
            }),
            admin: {
              updateUserById: async () => {
                passwordWrites++;
                return { error: null };
              },
            },
          },
        },
      },
    ],
  })
  class Root {}
  const app = await createHttpApplication(Root, {
    origins: [],
    bodyLimit: 100000,
    rateLimit: { max: 1000, windowMs: 60000 },
  });
  return { app, passwordWrites: () => passwordWrites };
}
const headers = { authorization: 'Bearer test', 'x-shop-id': SHOP_ID };
test('session/profile require authentication but no selected shop; profile fields are explicit', async () => {
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
    assert.equal(
      (await request(h.app.getHttpServer()).get('/api/v1/session')).status,
      401,
    );
    const session = await request(h.app.getHttpServer())
      .get('/api/v1/session')
      .set('authorization', 'Bearer test');
    assert.equal(session.status, 200);
    assert.equal(session.body.memberships[0].shop.id, SHOP_ID);
    const profile = await request(h.app.getHttpServer())
      .get('/api/v1/profile')
      .set('authorization', 'Bearer test');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.createdAt, date.toISOString());
    assert.equal('secret' in profile.body.profile, false);
    assert.equal(
      (
        await request(h.app.getHttpServer())
          .get('/api/v1/shop')
          .set('authorization', 'Bearer test')
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
      .set('authorization', 'Bearer test')
      .send({ name: 'Shop' });
    assert.equal(response.status, 201);
    assert.equal(response.body.shop.targetProfitMargin, '30.00');
    assert.equal('privateColumn' in response.body.shop, false);
    assert.equal(db.onlyCallTo('insert', 'shopMembers').inTransaction, true);
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
  const h = await fixture(db, 'member', 'another-user');
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
          .set('authorization', 'Bearer test')
          .send({ currentPassword: 'private', newPassword: 'private-new' })
      ).status,
      400,
    );
    assert.equal(h.passwordWrites(), 0);
    assert.equal(db.calls.length, 0);
  } finally {
    await h.app.close();
  }
});

test('camelCase catalog queries reject aliases and parse false as false',async()=>{
 const {inventoryQuerySchema,recipeQuerySchema}=await import('../src/modules/catalog/contracts.js');
 assert.equal(inventoryQuerySchema.parse({includeInactive:'false'}).includeInactive,false);
 assert.equal(recipeQuerySchema.parse({includeUnverified:'true'}).includeUnverified,true);
 assert.throws(()=>inventoryQuerySchema.parse({include_inactive:'true'}));
 assert.throws(()=>recipeQuerySchema.parse({include_unverified:'true'}));
 assert.throws(()=>inventoryQuerySchema.parse({lowStockOnly:'no'}));
});

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { Database } from '../../src/db/client.js';
import { createHttpApplication } from '../../src/http/application.js';
import { IdentityModule } from '../../src/modules/identity/identity.module.js';
import type { ActorContext, ShopRole } from '../../src/modules/identity/contracts.js';
import { OrdersController } from '../../src/modules/orders/orders.controller.js';
import { OrdersService } from '../../src/modules/orders/orders.service.js';
import { OrdersPersistence, ORDERS_DATABASE } from '../../src/modules/orders/orders.persistence.js';
import { OrdersAudit } from '../../src/modules/orders/orders.audit.js';
import { apiLogger } from '../../src/lib/logger/index.js';
import type { AuditInput } from '../../src/lib/audit.js';
export const SHOP_ID = '22222222-2222-2222-2222-222222222222';
export const USER_ID = '33333333-3333-3333-3333-333333333333';
export const TEST_SHOP = {
  id: SHOP_ID, name: 'Shop', slug: 'shop', currency: 'USD', timezone: 'UTC', storeAddress: null, targetProfitMargin: '30.00', hourlyLaborCost: '25.00', deliveryBaseFee: '5.00', deliveryRatePerKm: '1.50'
};
export function actorFor(role: ShopRole = 'owner'): ActorContext {
  return {
    shop: TEST_SHOP, user: {
      id: USER_ID, email: null, fullName: null, avatarUrl: null
    }, role, requestId: 'request', traceId: 'trace', log: apiLogger
  };
}
export async function buildNestOrdersApp(role: ShopRole = 'owner', database: Database = {} as Database) {
  let current = database;
  const audits: AuditInput[] = [];
  const databaseProxy = new Proxy({} as Database, { get(_target, key) {
      const value = Reflect.get(current, key);
      return typeof value === 'function' ? value.bind(current) : value;
    } });
  @Module({
    imports: [IdentityModule.register({
        sessionVerifier: { verify: async () => ({ id: USER_ID, email: null }) },
        repository: {
          findMembership: async (_userId, shopId) => shopId === SHOP_ID ? { shopId, role } : null,
          findShop: async () => TEST_SHOP, findProfile: async () => null,
        },
      })], controllers: [OrdersController], providers: [
      { provide: ORDERS_DATABASE, useValue: databaseProxy }, OrdersPersistence, OrdersService,
      { provide: OrdersAudit, useValue: { record: async (_actor: ActorContext, input: AuditInput) => { audits.push(input); } } },
    ]
  })
  class TestOrdersModule {
  }
  const app = await createHttpApplication(TestOrdersModule, {
    origins: [], bodyLimit: 100000, rateLimit: { max: 1000, windowMs: 60000 }
  });
  return {
    app, audits, use(next: {
      db: Database;
    }) { current = next.db; }, close: () => app.close()
  };
}

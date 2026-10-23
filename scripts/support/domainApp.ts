import type { Database } from '../../src/db/client.js';
import type { MediaUploadDeps } from '../../src/lib/mediaUploads.js';
import { mediaUploadServices } from '../../src/lib/mediaUploads.js';
import {
  defaultUploadServices,
  UPLOAD_SERVICES,
} from '../../src/modules/uploads/uploads.persistence.js';
import { AppModule } from '../../src/app.js';
import { CATALOG_DATABASE } from '../../src/modules/catalog/catalog.persistence.js';
import { CATALOG_SEARCH } from '../../src/modules/catalog/catalog.service.js';
import { CatalogAudit } from '../../src/modules/catalog/catalog.audit.js';
import { OrdersAudit } from '../../src/modules/orders/orders.audit.js';
import { ORDERS_DATABASE } from '../../src/modules/orders/orders.persistence.js';
import { RECEIPTS_DATABASE } from '../../src/modules/receipts/receipts.persistence.js';
import {
  SHOPS_DATABASE,
  ShopsPersistence,
} from '../../src/modules/shops/shops.persistence.js';
import { SHOPS_AUDIT } from '../../src/modules/shops/shops.service.js';
import { ANALYTICS_DEPS } from '../../src/modules/analytics/analytics.persistence.js';
import { SYNC_DATABASE } from '../../src/modules/sync/sync.persistence.js';
import {
  IdentityRepository,
  SessionVerifier,
} from '../../src/modules/identity/identity.ports.js';
import type {
  ShopContext,
  ShopRole,
} from '../../src/modules/identity/contracts.js';
import { searchProduct } from '../../src/lib/supermarket/prices.js';
import { testApplication, httpClient } from './httpClient.js';
export const SHOP_ID = '22222222-2222-2222-2222-222222222222',
  USER_ID = '33333333-3333-3333-3333-333333333333';
export const TEST_SHOP: ShopContext = {
  id: SHOP_ID,
  name: 'Test Shop',
  slug: 'test-shop',
  currency: 'USD',
  timezone: 'UTC',
  storeAddress: null,
  targetProfitMargin: '30.00',
  hourlyLaborCost: '25.00',
  deliveryBaseFee: '5.00',
  deliveryRatePerKm: '1.50',
};
export interface DomainDeps {
  db: Database;
  deleteObject?: (key: string) => Promise<void>;
  uploads?: Omit<MediaUploadDeps, 'db'>;
  now?: () => Date;
}
export async function domainHarness(
  role: string = 'owner',
  search: typeof searchProduct = searchProduct,
) {
  let current: DomainDeps | undefined;
  const database = new Proxy({} as Database, {
    get(_target, key) {
      if (
        ![
          'select',
          'insert',
          'update',
          'delete',
          'execute',
          'transaction',
        ].includes(String(key))
      )
        return undefined;
      return (...args: unknown[]) => {
        if (!current) throw new Error('Test database was not configured');
        const fn = Reflect.get(current.db, key);
        return Reflect.apply(fn, current.db, args);
      };
    },
  });
  const uploads = {
    ...defaultUploadServices,
    db: database,
    ...Object.fromEntries(
      Object.keys(mediaUploadServices).map((key) => [
        key,
        (...args: unknown[]) =>
          Reflect.apply(
            Reflect.get(current?.uploads ?? mediaUploadServices, key),
            undefined,
            args,
          ),
      ]),
    ),
  };
  const app = await testApplication(AppModule, [
    [CATALOG_DATABASE, database],
    [ORDERS_DATABASE, database],
    [RECEIPTS_DATABASE, database],
    [SHOPS_DATABASE, database],
    [SYNC_DATABASE, database],
    [CATALOG_SEARCH, search],
    [UPLOAD_SERVICES, uploads],
    [
      ANALYTICS_DEPS,
      {
        db: database,
        now: () => current?.now?.() ?? new Date('2026-06-15T12:34:56Z'),
      },
    ],
    [CatalogAudit, { record: async () => {} }],
    [OrdersAudit, { record: async () => {} }],
    [SHOPS_AUDIT, async () => {}],
    [
      SessionVerifier,
      {
        verify: async (token: string) =>
          token === 'test'
            ? { id: USER_ID, email: 'tester@example.com' }
            : null,
      },
    ],
    [
      IdentityRepository,
      {
        findProfile: async () => null,
        findMembership: async (_id: string, shopId: string) =>
          shopId === SHOP_ID ? { shopId, role: role as ShopRole } : null,
        findShop: async () => TEST_SHOP,
      },
    ],
  ]);
  const client = httpClient(app, {
    authorization: 'Bearer test',
    'x-shop-id': SHOP_ID,
  });
  return {
    app: client,
    nest: app,
    use: (deps: DomainDeps) => {
      current = deps;
    },
    close: () => app.close(),
  };
}

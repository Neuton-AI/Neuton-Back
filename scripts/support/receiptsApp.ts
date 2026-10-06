/**
 * A Fastify instance carrying the receipt routes with the auth guards stubbed.
 *
 * `receiptRoutes` is registered unmodified, so the verification endpoint under
 * test is the production one. Only the three guards are replaced — they would
 * otherwise reach Supabase and a live Postgres — and `request.receiptsDeps` is
 * the production seam, so the verification transaction runs against whatever
 * database the test hands it.
 *
 * The error handler mirrors the one in `src/app.ts` for the same reason
 * `scripts/support/testApp.ts` keeps its own copy: the validation assertions here
 * are only meaningful while the two envelopes agree.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import type { ShopContext } from '../../src/plugins/auth.js';
import { receiptRoutes, type ReceiptsDeps } from '../../src/routes/receipts.js';

export const SHOP_ID = '22222222-2222-2222-2222-222222222222';
export const USER_ID = '33333333-3333-3333-3333-333333333333';

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

export interface ReceiptsHarness {
  app: FastifyInstance;
  /** Point the next request at a different database. */
  use(deps: ReceiptsDeps): void;
  close(): Promise<void>;
}

/** Mirrors the flat envelope in `src/app.ts`. Keep the two in step. */
function errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    return reply
      .code(400)
      .send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues } });
  }
  if (error instanceof AppError) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message, details: error.details } });
  }
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code ?? 'REQUEST_ERROR', message: error.message } });
  }
  return reply
    .code(500)
    .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}

export async function buildReceiptsApp(): Promise<ReceiptsHarness> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);

  app.decorateRequest('shop', undefined);
  app.decorateRequest('user', undefined);
  app.decorateRequest('shopRole', undefined);
  app.decorateRequest('receiptsDeps', undefined);

  app.decorate('authenticate', async (request) => {
    request.user = { id: USER_ID, email: 'tester@example.com', fullName: null, avatarUrl: null };
  });
  app.decorate('resolveShop', async (request) => {
    request.shop = TEST_SHOP;
    request.shopRole = 'owner';
  });
  app.decorate('requireRole', (allowed: string[]) => async (request) => {
    if (!request.shopRole || !allowed.includes(request.shopRole)) {
      throw new Error(`Requires one of the roles: ${allowed.join(', ')}`);
    }
  });

  let deps: ReceiptsDeps | undefined;
  app.addHook('onRequest', async (request) => {
    request.receiptsDeps = deps;
  });

  await app.register(receiptRoutes, { prefix: '/api/v1' });
  await app.ready();

  return {
    app,
    use(next) {
      deps = next;
    },
    close: () => app.close(),
  };
}
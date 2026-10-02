/**
 * A Fastify instance carrying the analytics routes with the auth guards stubbed.
 *
 * `analyticsRoutes` is registered unmodified, so the route bodies under test are
 * the production ones. Only the two guards are replaced: they would otherwise
 * reach Supabase and a live Postgres. `request.analyticsDeps` is the production
 * seam, so the aggregations run against a `FakeDb` and a pinned clock.
 *
 * The error handler below mirrors the one in `src/app.ts` rather than importing
 * it, because `src/app.ts` belongs to N-3 and this branch must not touch it.
 * **If the envelope in `src/app.ts` changes, change it here too** — the
 * validation assertions in `analytics.test.ts` are only meaningful while the two
 * agree.
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
import { analyticsRoutes, type AnalyticsDeps } from '../../src/routes/analytics.js';

export const SHOP_ID = '22222222-2222-2222-2222-222222222222';

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

export interface AnalyticsHarness {
  app: FastifyInstance;
  /** Point the next request at a different database or clock. */
  use(deps: AnalyticsDeps): void;
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

export async function buildAnalyticsApp(): Promise<AnalyticsHarness> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);

  app.decorateRequest('shop', undefined);
  app.decorateRequest('analyticsDeps', undefined);

  app.decorate('authenticate', async () => {});
  app.decorate('resolveShop', async (request) => {
    request.shop = TEST_SHOP;
  });

  let deps: AnalyticsDeps | undefined;
  app.addHook('onRequest', async (request) => {
    request.analyticsDeps = deps;
  });

  await app.register(analyticsRoutes, { prefix: '/api/v1' });
  await app.ready();

  return {
    app,
    use(next) {
      deps = next;
    },
    close: () => app.close(),
  };
}

/** Fixed clock so period maths and graph buckets are reproducible. */
export const NOW = new Date('2026-06-15T12:34:56.000Z');

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { corsOrigins, env } from './env.js';
import { registerErrorHandler } from './lib/errorHandler.js';
import { loggerFactory } from './lib/logger/index.js';
import { authPlugins, requireAuth, requireShopContext } from './plugins/auth.js';
import { shopRoutes } from './routes/shops.js';
import { catalogRoutes } from './routes/catalog.js';
import { receiptRoutes } from './routes/receipts.js';
import { orderRoutes } from './routes/orders.js';
import { analyticsRoutes } from './routes/analytics.js';

export interface BuildAppOptions {
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation id bound in the onRequest hook (issue #99). */
    traceId: string;
  }
}

/**
 * Correlation id (issue #99): explicit `x-trace-id` wins (Faro / API clients),
 * then the W3C `traceparent` trace id that Faro's tracing instrumentation
 * propagates on fetch, then a fresh uuid so every line of a request can still
 * be grouped together.
 */
function resolveTraceId(headers: Record<string, string | string[] | undefined>): string {
  const explicit = Array.isArray(headers['x-trace-id'])
    ? headers['x-trace-id'][0]
    : headers['x-trace-id'];
  if (explicit && /^[A-Za-z0-9_-]{1,128}$/.test(explicit)) return explicit;

  const traceparent = Array.isArray(headers.traceparent)
    ? headers.traceparent[0]
    : headers.traceparent;
  if (traceparent) {
    const [, traceId] = traceparent.split('-');
    if (traceId && /^[0-9a-f]{32}$/i.test(traceId)) return traceId;
  }

  return randomUUID();
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // The facade owns levels, redaction and transport selection (issue #99);
    // Fastify's own request logging is replaced by the hooks below.
    ...(options.logger === false
      ? ({ logger: false } as const)
      : { loggerInstance: loggerFactory.createFastifyLogger() }),
    // Fastify's built-in request lines are replaced by the onResponse hook below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_BYTES,
  });

  /**
   * Error handling is registered before every plugin and route; that ordering
   * and the full envelope (Zod, AppError, 4xx, transient-DB 503 + Retry-After,
   * generic 500 — `traceId` on every body) live in `registerErrorHandler`.
   * See `src/lib/errorHandler.ts` for why the position is load-bearing.
   */
  registerErrorHandler(app);

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` } }),
  );

  app.decorateRequest('traceId', '');

  /**
   * Correlation hooks (issue #99 DOD). The request logger's context provider
   * is evaluated on every write, so `userId`/`shopId` — populated later, in
   * auth's preHandler hooks — appear on each line of the request that has
   * them, without re-binding anything when auth resolves.
   */
  app.addHook('onRequest', async (request, reply) => {
    request.traceId = resolveTraceId(request.headers);
    const log = loggerFactory.createRequestLogger(() => ({
      requestId: request.id,
      traceId: request.traceId,
      userId: request.user?.id,
      shopId: request.shop?.id,
    }));
    request.log = log;
    reply.log = log;
    request.log.debug({ method: request.method, url: request.url }, 'incoming request');
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) cb(null, true);
      else cb(new Error('Origin not allowed by CORS'), false);
    },
    // Retry-After and X-Trace-Id (N-110) are not on the CORS safelist, so the
    // browser would otherwise hide them from the client that needs them.
    exposedHeaders: ['Retry-After', 'X-Trace-Id'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
  });

  await app.register(requireAuth);
  await app.register(requireShopContext);

  app.get('/health', async () => ({ ok: true, service: 'neuton-api' }));

  await app.register(shopRoutes, { prefix: '/api/v1' });
  await app.register(catalogRoutes, { prefix: '/api/v1' });
  await app.register(receiptRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });
  await app.register(analyticsRoutes, { prefix: '/api/v1' });

  return app;
}

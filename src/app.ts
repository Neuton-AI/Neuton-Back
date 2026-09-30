import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { corsOrigins, env, isProduction } from './env.js';
import { AppError } from './lib/errors.js';
import { authPlugins, requireAuth, requireShopContext } from './plugins/auth.js';
import { shopRoutes } from './routes/shops.js';
import { catalogRoutes } from './routes/catalog.js';
import { receiptRoutes } from './routes/receipts.js';
import { orderRoutes } from './routes/orders.js';
import { analyticsRoutes } from './routes/analytics.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          '*.password',
          '*.token',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_BYTES,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) cb(null, true);
      else cb(new Error('Origin not allowed by CORS'), false);
    },
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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.issues },
      });
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

    request.log.error({ err: error }, 'unhandled request error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` } }),
  );

  return app;
}

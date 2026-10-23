import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { NextFunction, Response } from 'express';
import { apiLogger } from '../lib/logger/index.js';
import type { Logger } from '../lib/logger/types.js';
import { ApiExceptionFilter } from './exception-filter.js';
import { resolveTraceId, type HttpRequest } from './request-context.js';

export interface HttpOptions {
  origins: string[];
  bodyLimit: number;
  rateLimit: { max: number; windowMs: number };
  /** Explicit trusted proxy addresses/subnets; direct deployments trust none. */
  trustProxy?: string[];
  logger?: Logger;
  observe?: (event: Record<string, unknown>) => void;
}

/** Shared production/test setup. Raw bytes are retained for signed webhooks. */
export async function createHttpApplication(rootModule: Type, options: HttpOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, { rawBody: true, logger: false, abortOnError: false });
  return configureHttpApplication(app,options);
}

export async function configureHttpApplication(app:NestExpressApplication, options:HttpOptions):Promise<NestExpressApplication>{
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? false);
  app.use((req: HttpRequest, res: Response, next: NextFunction) => {
    const started = performance.now();
    req.requestId = randomUUID();
    req.traceId = resolveTraceId(req.headers);
    req.log = (options.logger ?? apiLogger).child({ requestId: req.requestId, traceId: req.traceId, entryPoint: 'http' });
    res.setHeader('X-Trace-Id', req.traceId);
    res.once('finish', () => {
      const event = {
        event: 'http_request_completed', entryPoint: 'http', requestId: req.requestId,
        traceId: req.traceId, method: req.method, route: req.route?.path ?? 'unmatched',
        statusCode: res.statusCode, durationMs: Math.round(performance.now() - started),
      };
      req.log.info(event, 'request completed');
      options.observe?.(event);
    });
    next();
  });
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: {
    defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"],
  } } }));
  app.enableCors({
    origin: (origin, callback) => callback(origin && !options.origins.includes(origin) ? new Error('Origin not allowed') : null, true),
    credentials: true, exposedHeaders: ['Retry-After', 'X-Trace-Id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  app.use(rateLimit({
    windowMs: options.rateLimit.windowMs, limit: options.rateLimit.max,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: {
      code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', traceId: (req as HttpRequest).traceId,
    } }),
  }));
  app.useBodyParser('json', { limit: options.bodyLimit });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return app;
}

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { MIMEType } from 'node:util';
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
import { AppError, forbidden, tooLarge } from '../lib/errors.js';

const credentialRoute = /^\/api\/v1\/(?:auth\/(?:signup|signin|google\/(?:start|complete))|profile\/password)\/?$/i;
const credentialBodyLimit = 32_768;
const isCredentialPost = (request: HttpRequest) =>
  request.method === 'POST' && credentialRoute.test(request.path);

function supportsCredentialJson(request: HttpRequest) {
  const encoding = request.headers['content-encoding']?.toLowerCase() ?? 'identity';
  if (encoding !== 'identity' || !request.is('application/json')) return false;
  const charset = new MIMEType(request.headers['content-type']!).params.get('charset');
  return !charset || charset.toLowerCase() === 'utf-8';
}

async function rejectUnsupportedCredentialBody(request: HttpRequest) {
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += (chunk as Buffer).length;
    if (bytes > credentialBodyLimit) {
      request.resume();
      return tooLarge('Request body too large');
    }
  }
  return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected uncompressed UTF-8 JSON');
}

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
    if (/^\/api\/v1\/(auth(?:\/|$)|session\/?$|profile\/password\/?$)/i.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
    }
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
  app.enableCors((request: HttpRequest, done) => done(null, {
    origin: (origin, callback) => {
      if (!origin || options.origins.includes(origin)) return callback(null, true);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return callback(forbidden('Origin not allowed'));
      return callback(new Error('Origin not allowed'));
    },
    credentials: true, exposedHeaders: ['Retry-After', 'X-Trace-Id'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }));
  for (const path of ['/api/v1/auth/signup', '/api/v1/profile/password']) {
    app.use(path, rateLimit({
      windowMs: 60_000,
      limit: 12,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) => res.status(429).json({ error: {
        code: 'RATE_LIMIT_EXCEEDED', message: 'Too many authentication attempts', traceId: (req as HttpRequest).traceId,
      } }),
    }));
  }
  app.use(rateLimit({
    windowMs: options.rateLimit.windowMs, limit: options.rateLimit.max,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: {
      code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests', traceId: (req as HttpRequest).traceId,
    } }),
  }));
  app.use((req: HttpRequest, _res: Response, next: NextFunction) => {
    if (!isCredentialPost(req)) return next();
    if (Number(req.headers['content-length']) > credentialBodyLimit) {
      req.resume();
      return next(tooLarge('Request body too large'));
    }
    if (req.is('application/json') !== null && !supportsCredentialJson(req)) {
      // Count unsupported bodies without buffering or decoding them.
      void rejectUnsupportedCredentialBody(req).then(next, next);
      return;
    }
    next();
  });
  app.useBodyParser('json', {
    limit: credentialBodyLimit,
    inflate: false,
    type: (request) => isCredentialPost(request as HttpRequest),
  });
  app.useBodyParser('json', { limit: options.bodyLimit });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return app;
}

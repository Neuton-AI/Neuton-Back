import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import {
  isTransientDatabaseError,
  RETRY_AFTER_SECONDS,
  SERVICE_UNAVAILABLE_CODE,
  SERVICE_UNAVAILABLE_MESSAGE,
} from './dbErrors.js';

/**
 * Error handling is registered before every plugin and route, and that order is
 * load-bearing. Fastify resolves a route context's error handler when the route
 * is added and keeps that reference on the context (`lib/context.js`:
 * `this.errorHandler = errorHandler || server[kErrorHandler]`). A handler set
 * afterwards never reaches routes that already exist.
 *
 * When this used to sit below the route plugins, every route kept Fastify's
 * built-in handler: each `AppError` 4xx/409/413 and each `z.parse()` failure
 * answered 500 with the raw internal message, to unauthenticated callers.
 *
 * Registering ahead of `@fastify/cors` as well is deliberate: a rejected origin
 * is raised from that plugin's `onRequest` hook, so it reaches this handler and
 * gets the flat generic 500 instead of "Origin not allowed by CORS".
 *
 * Every envelope carries the request's `traceId` so a client that reports a
 * failure can be correlated to the exact log lines (N-110). A transient
 * database failure (Supabase cold-start, dropped connection, server not ready)
 * answers 503 + `Retry-After` instead of masquerading as a permanent 500.
 *
 * Covered by scripts/error-handler.test.ts and scripts/transient-db-errors.test.ts.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Mirrored on the wire so a client that only inspects headers can still
    // correlate this failure to the log lines (N-110).
    if (request.traceId) reply.header('X-Trace-Id', request.traceId);
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send(errorEnvelope(request, 'VALIDATION_ERROR', 'Invalid request', error.issues));
    }
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send(errorEnvelope(request, error.code, error.message, error.details));
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send(errorEnvelope(request, error.code ?? 'REQUEST_ERROR', error.message));
    }

    if (isTransientDatabaseError(error)) {
      request.log.error(
        { err: error, traceId: request.traceId },
        'database temporarily unavailable',
      );
      // Advertised before send so the header lands on the 503 response.
      reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return reply
        .code(503)
        .send(
          errorEnvelope(request, SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE),
        );
    }

    request.log.error({ err: error, traceId: request.traceId }, 'unhandled request error');
    return reply
      .code(500)
      .send(errorEnvelope(request, 'INTERNAL_ERROR', 'Something went wrong'));
  });
}

/**
 * The flat error body every branch returns. `details` is omitted entirely when
 * absent (rather than serialized as `undefined`) and `traceId` is only included
 * once the correlation hook has resolved it.
 */
function errorEnvelope(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: unknown,
): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  if (request.traceId) error.traceId = request.traceId;
  return { error };
}

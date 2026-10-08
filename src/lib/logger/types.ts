import type { FastifyBaseLogger } from 'fastify';

/**
 * Log levels exposed by the facade. Deliberately stops at `fatal`: pino's
 * `trace`/`silent` exist only so the adapter satisfies Fastify's logger
 * contract and map onto "debug" and "off".
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Emitted on every line as the Loki/stdout `service` discriminator. */
export type LoggerService = 'api' | 'worker' | 'gemini';

/** Structured fields merged into a log line. */
export type LogMeta = Record<string, unknown>;

/** Correlation and identity fields merged into every line a logger emits. */
export type LogContext = Record<string, unknown>;

/**
 * pino-style call shapes, all supported interchangeably:
 *   logger.info('message', { meta })     // message first
 *   logger.info({ meta }, 'message')     // meta first
 *   logger.error(error, { meta })        // Error first — lands under `err`
 */
export type LogFn = {
  (message: string, meta?: LogMeta): void;
  (meta: LogMeta, message?: string): void;
  (error: Error, meta?: LogMeta): void;
};

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** Returns a logger with `context` merged over the parent's; the transport is shared. */
  child(context: LogContext): Logger;
}

/**
 * Process-wide entry point for creating loggers (issue #99): one factory owns
 * the transport selection and is flushed exactly once during shutdown.
 */
export interface LoggerFactory {
  create(service: LoggerService, context?: LogContext): Logger;
  /** Root Fastify logger, passed to Fastify as `loggerInstance`. */
  createFastifyLogger(service?: LoggerService): FastifyBaseLogger;
  /**
   * Per-request Fastify logger. `provider` is evaluated on every write so
   * fields set mid-request (`userId`, `shopId` after auth hooks) show up on
   * each line without re-creating the logger.
   */
  createRequestLogger(provider: () => LogContext, service?: LoggerService): FastifyBaseLogger;
  /** Flushes every transport this process opened. Idempotent. */
  shutdown(): Promise<void>;
}

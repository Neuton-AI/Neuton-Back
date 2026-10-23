/**
 * Log levels exposed consistently across HTTP, workers and providers.
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
  /** Flushes every transport this process opened. Idempotent. */
  shutdown(): Promise<void>;
}

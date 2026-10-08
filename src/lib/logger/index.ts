import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../env.js';
import {
  createTransport,
  type Transport,
  type TransportKind,
} from './transports/index.js';
import type {
  LogContext,
  LoggerFactory,
  Logger,
  LoggerService,
  LogLevel,
  LogMeta,
} from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/** Loki stream label + every line's `environment` field. */
const environment = env.LOG_ENV ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
/** Every line's `version` field (release identifier, issue #99 DOD). */
const version = env.APP_VERSION ?? env.GIT_SHA ?? 'dev';

/**
 * Maps Fastify/pino level strings onto the facade's levels: `silent` turns
 * the logger off, `trace` degrades to `debug` (the facade has no trace level),
 * anything unknown turns the logger off rather than crashing a request.
 */
function normalizeLevel(value: string): LogLevel | null {
  if (value === 'silent') return null;
  if (value === 'trace') return 'debug';
  if (value in LEVEL_ORDER) return value as LogLevel;
  return null;
}

function isLogMeta(value: unknown): value is LogMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    !Array.isArray(value)
  );
}

interface NormalizedArgs {
  message?: string;
  meta: LogMeta;
}

/**
 * Collapses the three accepted call shapes into one `(message, meta)` pair.
 * An Error first argument is copied into `err` so pino's serializer picks it
 * up, which is what the Loki DOD queries (`| json | level="error"`) rely on.
 */
function normalizeArgs(first: unknown, second: unknown): NormalizedArgs {
  if (first instanceof Error) {
    return {
      message: first.message,
      meta: { ...(isLogMeta(second) ? second : {}), err: first },
    };
  }
  return {
    message: typeof first === 'string' ? first : typeof second === 'string' ? second : undefined,
    meta: isLogMeta(first) ? first : isLogMeta(second) ? second : {},
  };
}

/**
 * Layer 2 of the architecture (issue #99): the facade every service logs
 * through. Owns level filtering and context merging; writes to a Transport
 * (layer 3) and never touches a provider SDK itself.
 */
export class LoggerImpl implements Logger {
  #minLevel: LogLevel | null;

  constructor(
    private readonly transport: Transport,
    private readonly context: LogContext,
    minLevel: LogLevel | null,
    private readonly dynamic?: () => LogContext,
  ) {
    this.#minLevel = minLevel;
  }

  /** `null` means silenced (Fastify's `silent` level). */
  get level(): LogLevel | null {
    return this.#minLevel;
  }

  set level(value: LogLevel | null) {
    this.#minLevel = value;
  }

  /**
   * Write path shared with the Fastify adapter. `first`/`second` may be any of
   * the accepted call shapes; `write` is public because the adapter forwards
   * loosely-typed Fastify log calls into it.
   */
  write(level: LogLevel, first?: unknown, second?: unknown): void {
    if (this.#minLevel === null) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;
    const { message, meta } = normalizeArgs(first, second);
    const dynamic = this.dynamic?.();
    this.transport.write(level, message, {
      ...this.context,
      ...(dynamic ?? {}),
      ...meta,
    });
  }

  debug(message: string, meta?: LogMeta): void;
  debug(meta: LogMeta, message?: string): void;
  debug(error: Error, meta?: LogMeta): void;
  debug(first?: unknown, second?: unknown): void {
    this.write('debug', first, second);
  }

  info(message: string, meta?: LogMeta): void;
  info(meta: LogMeta, message?: string): void;
  info(error: Error, meta?: LogMeta): void;
  info(first?: unknown, second?: unknown): void {
    this.write('info', first, second);
  }

  warn(message: string, meta?: LogMeta): void;
  warn(meta: LogMeta, message?: string): void;
  warn(error: Error, meta?: LogMeta): void;
  warn(first?: unknown, second?: unknown): void {
    this.write('warn', first, second);
  }

  error(message: string, meta?: LogMeta): void;
  error(meta: LogMeta, message?: string): void;
  error(error: Error, meta?: LogMeta): void;
  error(first?: unknown, second?: unknown): void {
    this.write('error', first, second);
  }

  fatal(message: string, meta?: LogMeta): void;
  fatal(meta: LogMeta, message?: string): void;
  fatal(error: Error, meta?: LogMeta): void;
  fatal(first?: unknown, second?: unknown): void {
    this.write('fatal', first, second);
  }

  /** Shares the transport; `context` is merged over the parent's. */
  child(context: LogContext): LoggerImpl {
    return new LoggerImpl(this.transport, { ...this.context, ...context }, this.#minLevel, this.dynamic);
  }

  /**
   * Returns a copy whose context provider is re-evaluated on every write.
   * Fastify request loggers use this so fields populated mid-request (after
   * auth) appear without rebuilding the logger per log line.
   */
  withDynamic(dynamic: () => LogContext): LoggerImpl {
    return new LoggerImpl(this.transport, this.context, this.#minLevel, dynamic);
  }
}

/**
 * Adapter between the facade's LogFn and Fastify's logger contract. Also
 * satisfies `validateLogger` (info/error/debug/fatal/warn/trace/child);
 * `trace` and `silent` exist purely for that contract — trace degrades to
 * debug via level normalization and silent is a no-op.
 */
export class FastifyLoggerAdapter implements FastifyBaseLogger {
  constructor(private readonly logger: LoggerImpl) {}

  get level(): LogLevel | 'silent' {
    return this.logger.level ?? 'silent';
  }

  set level(value: string) {
    this.logger.level = normalizeLevel(value);
  }

  info(first?: unknown, second?: unknown): void {
    this.logger.write('info', first, second);
  }

  error(first?: unknown, second?: unknown): void {
    this.logger.write('error', first, second);
  }

  debug(first?: unknown, second?: unknown): void {
    this.logger.write('debug', first, second);
  }

  fatal(first?: unknown, second?: unknown): void {
    this.logger.write('fatal', first, second);
  }

  warn(first?: unknown, second?: unknown): void {
    this.logger.write('warn', first, second);
  }

  /** No trace level in this architecture (issue #99): absorbed as debug. */
  trace(first?: unknown, second?: unknown): void {
    this.logger.write('debug', first, second);
  }

  /** Fastify/pino compatibility only: writes nothing. */
  silent(): void {
    // intentionally empty
  }

  child(bindings: LogContext, _options?: unknown): FastifyBaseLogger {
    return new FastifyLoggerAdapter(this.logger.child(bindings));
  }
}

/**
 * Creates the underlying transport on first write, so processes never spawn a
 * Loki worker thread for a service they do not log through (an API process
 * creates no `gemini` worker, and vice versa).
 */
class LazyTransport implements Transport {
  #target?: Transport;

  constructor(private readonly create: () => Transport) {}

  write(level: LogLevel, message: string | undefined, meta: Record<string, unknown>): void {
    (this.#target ??= this.create()).write(level, message, meta);
  }

  async flush(): Promise<void> {
    await this.#target?.flush?.();
  }
}

/**
 * Prod ships to Loki (GRAFANA_LOKI_TOKEN required — without it a warning is
 * printed and stdout pretty logs keep the process debuggable rather than
 * silently losing data); dev renders pretty lines; tests discard them.
 */
function resolveTransportKind(): TransportKind {
  if (env.NODE_ENV === 'test') return 'noop';
  if (env.NODE_ENV !== 'production') return 'pretty';
  if (env.GRAFANA_LOKI_TOKEN) return 'loki';
  // eslint-disable-next-line no-console
  console.error(
    '[logger] GRAFANA_LOKI_TOKEN is not set — logs go to stdout instead of Loki and will not be queryable in Grafana.',
  );
  return 'pretty';
}

class LoggerFactoryImpl implements LoggerFactory {
  readonly #transports = new Map<LoggerService, LazyTransport>();
  readonly #roots = new Map<LoggerService, LoggerImpl>();
  #shutdown = false;

  create(service: LoggerService, context: LogContext = {}): LoggerImpl {
    if (Object.keys(context).length === 0) {
      const cached = this.#roots.get(service);
      if (cached) return cached;
      const root = new LoggerImpl(this.#transportFor(service), {}, this.#minLevel());
      this.#roots.set(service, root);
      return root;
    }
    return new LoggerImpl(this.#transportFor(service), context, this.#minLevel());
  }

  createFastifyLogger(service: LoggerService = 'api'): FastifyBaseLogger {
    return new FastifyLoggerAdapter(this.create(service));
  }

  createRequestLogger(
    provider: () => LogContext,
    service: LoggerService = 'api',
  ): FastifyBaseLogger {
    return new FastifyLoggerAdapter(this.create(service).withDynamic(provider));
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await Promise.allSettled(
      [...this.#transports.values()].map((transport) => transport.flush()),
    );
  }

  #minLevel(): LogLevel {
    return env.NODE_ENV === 'production' ? 'info' : 'debug';
  }

  #transportFor(service: LoggerService): LazyTransport {
    const existing = this.#transports.get(service);
    if (existing) return existing;
    const transport = new LazyTransport(() =>
      createTransport(resolveTransportKind(), { service, environment, version }),
    );
    this.#transports.set(service, transport);
    return transport;
  }
}

export function createLoggerFactory(): LoggerFactory {
  return new LoggerFactoryImpl();
}

/** Process-wide factory: flushed exactly once in the SIGTERM handlers (DOD). */
export const loggerFactory = createLoggerFactory();

/** Singletons for app code (issue #99 DOD): one import, one facade. */
export const apiLogger = loggerFactory.create('api');
export const workerLogger = loggerFactory.create('worker');
export const geminiLogger = loggerFactory.create('gemini');

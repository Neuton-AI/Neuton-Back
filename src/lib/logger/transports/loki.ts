import { pino, transport, type Logger as PinoLogger } from 'pino';
import pinoLoki, { type LokiLogLevel } from 'pino-loki';
import { env } from '../../../env.js';
import type { LogLevel } from '../types.js';
import type { Transport, TransportContext } from './index.js';
import { REDACT_CENSOR, REDACT_PATHS, SERIALIZERS } from './shared.js';

/**
 * pino-loki maps `log.level` onto a Loki stream label through a numeric-keyed
 * table (10→debug, 30→info, …). Our facade serializes levels as strings
 * (`formatters.level`), which would fall through to `info` for every line, so
 * the table is re-keyed by label name.
 */
const STRING_LEVEL_MAP = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'critical',
} as unknown as Record<number, LokiLogLevel>;

/** The pino.transport() thread stream we must drain before the process exits. */
interface TransportStream {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  readonly destroyed?: boolean;
}

/**
 * Production transport: writes JSON lines to `pino-loki`, which batches them
 * (~5s) inside a worker thread and pushes to GRAFANA_LOG_URL with a Bearer
 * token from GRAFANA_LOKI_TOKEN. `service`/`environment` become Loki stream
 * labels; everything else (version, pid, traceId, …) stays in the JSON body.
 */
export class LokiTransport implements Transport {
  readonly #pino: PinoLogger;
  readonly #stream: TransportStream;
  #ending = false;

  constructor(context: TransportContext) {
    const pushUrl = new URL(env.GRAFANA_LOG_URL);
    const stream: TransportStream = transport({
      target: 'pino-loki',
      options: {
        host: pushUrl.origin,
        endpoint: `${pushUrl.pathname}${pushUrl.search}`,
        labels: { service: context.service, environment: context.environment },
        ...(env.GRAFANA_LOKI_TOKEN
          ? { headers: { Authorization: `Bearer ${env.GRAFANA_LOKI_TOKEN}` } }
          : {}),
        levelMap: STRING_LEVEL_MAP,
        batching: { interval: 5, maxBufferSize: 10_000 },
        // All context rides in the JSON body; Loki structured metadata is
        // string-only and would coerce numbers/objects.
        structuredMetaKey: false,
        silenceErrors: false,
      },
    });
    stream.on('error', (error) => {
      // After end() begins, writes race the shutdown flush; that is expected.
      if (!this.#ending) console.error(`[logger] loki transport error: ${error.message}`);
    });
    this.#stream = stream;
    this.#pino = pino(
      {
        level: 'trace',
        base: {
          service: context.service,
          environment: context.environment,
          version: context.version,
          pid: process.pid,
        },
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
        serializers: SERIALIZERS,
      },
      stream,
    );
  }

  write(level: LogLevel, message: string | undefined, meta: Record<string, unknown>): void {
    this.#pino[level](meta, message);
  }

  /**
   * Drains the worker thread: `end()` flushes queued lines into the worker
   * and waits for it to consume them; the worker's exit then awaits
   * pino-loki's own `close()` — which pushes the last partial batch — before
   * `close` fires here. The timeout only guards a hung worker.
   */
  async flush(): Promise<void> {
    if (this.#stream.destroyed) return;
    this.#ending = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      timer.unref();
      this.#stream.once('close', done);
      this.#stream.once('error', done);
      this.#stream.end();
    });
  }
}

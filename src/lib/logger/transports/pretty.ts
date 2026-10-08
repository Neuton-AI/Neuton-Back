import { pino, type Logger as PinoLogger } from 'pino';
import pinoPretty from 'pino-pretty';
import type { LogLevel } from '../types.js';
import type { Transport, TransportContext } from './index.js';
import { REDACT_CENSOR, REDACT_PATHS, SERIALIZERS } from './shared.js';

/**
 * Dev transport: pino-pretty runs as an in-process Transform (no worker
 * thread), so the process stays exitable — which is what made pino-pretty
 * unusable as a `transport.target` in tests and CI.
 */
export class PrettyTransport implements Transport {
  readonly #pino: PinoLogger;
  readonly #stream: { flush?: () => void };

  constructor(context: TransportContext) {
    const stream = pinoPretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    });
    this.#stream = stream as { flush?: () => void };
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

  async flush(): Promise<void> {
    this.#stream.flush?.();
  }
}

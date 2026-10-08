import type { LogLevel, LoggerService } from '../types.js';
import { LokiTransport } from './loki.js';
import { NoopTransport } from './noop.js';
import { PrettyTransport } from './pretty.js';

/** Static facts every transport stamps onto the lines it owns. */
export interface TransportContext {
  service: LoggerService;
  environment: string;
  version: string;
}

/**
 * The only thing the facade talks to: one `write` per accepted log call, plus
 * an optional `flush` awaited during shutdown. Provider SDKs (pino-loki,
 * pino-pretty) never leak past this interface (issue #99 layer 3).
 */
export interface Transport {
  write(level: LogLevel, message: string | undefined, meta: Record<string, unknown>): void;
  flush?(): Promise<void>;
}

export type TransportKind = 'loki' | 'pretty' | 'noop';

/**
 * Registry mapping the selected kind to its implementation. Kept as a switch
 * rather than a map so transports can stay lazily importable.
 */
export function createTransport(kind: TransportKind, context: TransportContext): Transport {
  switch (kind) {
    case 'loki':
      return new LokiTransport(context);
    case 'pretty':
      return new PrettyTransport(context);
    case 'noop':
    default:
      return new NoopTransport();
  }
}

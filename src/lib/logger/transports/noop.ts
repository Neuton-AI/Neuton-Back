import type { LogLevel } from '../types.js';
import type { Transport } from './index.js';

/**
 * Discards everything. Selected for `NODE_ENV=test` so suites never assert on
 * a wall of log lines and worker threads keep the process exitable.
 */
export class NoopTransport implements Transport {
  write(_level: LogLevel, _message: string | undefined, _meta: Record<string, unknown>): void {
    // intentionally empty
  }
}

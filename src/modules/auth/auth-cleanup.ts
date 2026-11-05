import { sql, type SQL } from 'drizzle-orm';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import type { Logger } from '../../lib/logger/types.js';

interface CleanupDatabase { execute(query: SQL): PromiseLike<unknown> }

/** Receives only the cleanup pool; SQL supplies the cross-process transaction lease and row bounds. */
export class AuthCleanupDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly database: CleanupDatabase, private readonly log: Pick<Logger, 'info' | 'error'>) {}

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => { void this.drain().catch(() => undefined); };
    this.timer = setInterval(tick, AUTH_POLICY.cleanup.intervalMs);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    try {
      await this.database.execute(sql`select app_private.cleanup_auth_records(${AUTH_POLICY.cleanup.batchSize}::integer)`);
      this.log.info({ event: 'auth_cleanup_completed', batchSize: AUTH_POLICY.cleanup.batchSize }, 'Auth retention pass completed');
    } catch (error) {
      this.log.error({ event: 'auth_cleanup_failed' }, 'Auth retention pass failed; will retry');
      throw error;
    }
  }
}

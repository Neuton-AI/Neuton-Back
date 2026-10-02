/**
 * Model selection with a short-lived "recently failed" memory.
 *
 * Capacity failures are per-model and transient, so the useful signal is
 * "that model was sick a minute ago". Remembering it — instead of walking a
 * fixed order — stops every worker from rediscovering the same outage in the
 * same sequence, which is what keeps a just-recovered model saturated.
 *
 * Pure logic on purpose: no network, no clock of its own, no randomness of its
 * own beyond an injectable source, so the policy is unit-testable.
 */

export interface LadderOptions {
  /** Full pool, most-preferred first. Order only matters once everything is flagged. */
  models: readonly string[];
  /** How long a model stays sidelined before it is tried again. */
  flagTtlMs: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  /** Injectable for deterministic tests. */
  now?: () => number;
}

export type FlagReason = 'unknown-model' | 'rate-limited' | 'unavailable' | 'unusable-response';

export class ModelLadder {
  private readonly flags = new Map<string, { until: number; reason: FlagReason }>();
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: LadderOptions) {
    if (opts.models.length === 0) throw new Error('ModelLadder requires a non-empty model pool');
    if (opts.flagTtlMs <= 0) throw new Error('ModelLadder requires a positive flagTtlMs');
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Sidelined a model until `now + flagTtlMs`. Re-flagging extends the window. */
  flag(model: string, reason: FlagReason): void {
    this.flags.set(model, { until: this.now() + this.opts.flagTtlMs, reason });
  }

  isFlagged(model: string): boolean {
    const entry = this.flags.get(model);
    if (!entry) return false;
    if (entry.until <= this.now()) {
      this.flags.delete(model);
      return false;
    }
    return true;
  }

  /** Models currently sidelined, with the reason. Exposed for diagnostics. */
  flagged(): Record<string, FlagReason> {
    const now = this.now();
    const out: Record<string, FlagReason> = {};
    for (const [model, entry] of this.flags) {
      if (entry.until > now) out[model] = entry.reason;
    }
    return out;
  }

  /** The pool a pick may choose from right now. */
  available(): string[] {
    const now = this.now();
    return this.opts.models.filter((m) => {
      const entry = this.flags.get(m);
      if (!entry) return true;
      if (entry.until <= now) {
        this.flags.delete(m);
        return true;
      }
      return false;
    });
  }

  /**
   * Randomly picks from the models not currently sidelined. A flag on the model
   * just chosen is not required: a caller that fails one flagging it here gets a
   * different model next time without any extra bookkeeping.
   *
   * When every model is sidelined the flags are cleared and the full pool is
   * used: a stale outage must not be able to wedge the worker permanently.
   */
  pick(): string {
    let pool = this.available();
    if (pool.length === 0) {
      this.flags.clear();
      pool = [...this.opts.models];
    }
    const index = Math.min(pool.length - 1, Math.floor(this.random() * pool.length));
    return pool[index] as string;
  }

  /** Forget every flag. Used when the pool has been wedged for too long. */
  reset(): void {
    this.flags.clear();
  }
}

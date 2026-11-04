import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { Logger } from "./logger/types.js";
import { queryRows, type SqlExecutor } from '../db/query-rows.js';
import { z } from 'zod';

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export async function scheduleObjectDeletions(
  database: Database | Transaction,
  input: {
    shopId: string;
    traceId: string;
    paths: readonly (string | null)[];
  },
) {
  const paths = [
    ...new Set(input.paths.filter((path): path is string => Boolean(path))),
  ];
  if (paths.some((path) => !path.startsWith(`${input.shopId}/`))) {
    throw new Error("Storage cleanup path is outside its shop");
  }
  if (paths.length) {
    await database.execute(sql`select app_private.enqueue_storage_deletions(
      ${sql`ARRAY[${sql.join(paths.map(path => sql`${path}::text`), sql`, `)}]::text[]`},${input.traceId}::text)`);
  }
}

export interface CleanupOptions {
  db: SqlExecutor;
  deleteObject: (path: string, signal?: AbortSignal) => Promise<void>;
  log: Logger;
  timeoutMs?: number;
  leaseMs?: number;
  batchSize?: number;
}

/** A leased deletion-specific outbox; importing it never starts a background timer. */
export class StorageCleanupDispatcher {
  private running?: Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly options: CleanupOptions) {}

  drain(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }
  start(intervalMs = 5000) {
    if (this.timer || this.stopped) return;
    const tick = () => {
      void this.drain().catch(() =>
        this.options.log.error(
          {
            event: "storage_cleanup_dispatch_failed",
            entryPoint: "storage_cleanup",
          },
          "cleanup dispatch failed",
        ),
      );
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.active) controller.abort();
    await this.running;
  }
  private async run(): Promise<number> {
    const { db, log } = this.options;
    const token = randomUUID();
    const timeout = Math.max(1, Math.min(120000, this.options.timeoutMs ?? 10000));
    const leaseSeconds = Math.ceil(Math.max(timeout * 2, this.options.leaseMs ?? 60000) / 1000);
    const limit = Math.max(1, Math.min(20, this.options.batchSize ?? 10));
    // One short atomic SQL statement claims work and releases DB locks before R2 I/O.
    const rows = await queryRows(db,
      sql`select * from app_private.claim_storage_deletions(${token}::uuid,${limit}::integer,${leaseSeconds}::integer)`,
      z.object({ id: z.string().uuid(), shop_id: z.string().uuid(), storage_path: z.string(), trace_id: z.string(), attempts: z.number().int() }));
    await Promise.all(
      rows.map(async (row) => {
        const context = log.child({
          entryPoint: "storage_cleanup",
          requestId: row.id,
          traceId: row.trace_id,
          shopId: row.shop_id,
        });
        const controller = new AbortController();
        this.active.add(controller);
        if (this.stopped) controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.options.deleteObject(row.storage_path, controller.signal),
            new Promise<never>((_resolve, reject) => {
              const fail = () => reject(new Error("Storage cleanup aborted"));
              if (controller.signal.aborted) {
                fail();
                return;
              }
              controller.signal.addEventListener("abort", fail, { once: true });
              timer = setTimeout(() => controller.abort(), timeout);
            }),
          ]);
          const [acknowledged] = await queryRows(db,
            sql`select app_private.complete_storage_deletion(${row.id}::uuid,${token}::uuid) as completed`, z.object({ completed: z.boolean() }));
          if (acknowledged?.completed) {
            context.info(
              { event: "storage_cleanup_deleted", attempt: row.attempts },
              "storage object deleted",
            );
          }
        } catch {
          const delay = Math.min(3600, 2 ** Math.min(row.attempts, 12));
          await db.execute(sql`select app_private.retry_storage_deletion(${row.id}::uuid,${token}::uuid,${delay}::integer)`);
          context.warn(
            { event: "storage_cleanup_retry", attempt: row.attempts },
            "storage cleanup will retry",
          );
        } finally {
          if (timer) clearTimeout(timer);
          this.active.delete(controller);
        }
      }),
    );
    return rows.length;
  }
}

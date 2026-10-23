import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { storageObjectDeletions } from "../db/schema/storage-cleanup.js";
import type { Logger } from "./logger/types.js";

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
  if (paths.some((path) => !path.startsWith(`${input.shopId}/`)))
    throw new Error("Storage cleanup path is outside its shop");
  if (paths.length)
    await database
      .insert(storageObjectDeletions)
      .values(
        paths.map((storagePath) => ({
          shopId: input.shopId,
          traceId: input.traceId,
          storagePath,
        })),
      )
      .onConflictDoNothing();
}

interface CleanupRow {
  id: string;
  storage_path: string;
  shop_id: string;
  trace_id: string;
  attempts: number;
}
export interface CleanupOptions {
  db: Database;
  deleteObject: (path: string, signal?: AbortSignal) => Promise<void>;
  log: Logger;
  now?: () => Date;
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
    if (!this.running)
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
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
    const now = (this.options.now ?? (() => new Date()))();
    const token = randomUUID();
    const timeout = Math.max(1, this.options.timeoutMs ?? 10000);
    const leaseUntil = new Date(
      now.getTime() + Math.max(timeout * 2, this.options.leaseMs ?? 60000),
    );
    const limit = Math.max(1, Math.min(20, this.options.batchSize ?? 10));
    // One short atomic SQL statement claims work and releases DB locks before R2 I/O.
    const rows = await db.execute(sql`with due as (
      select id from storage_object_deletions where next_attempt_at <= ${now.toISOString()}::timestamptz
      and (lease_until is null or lease_until <= ${now.toISOString()}::timestamptz)
      order by next_attempt_at,created_at for update skip locked limit ${limit}
    ) update storage_object_deletions d set lease_token=${token}::uuid,lease_until=${leaseUntil.toISOString()}::timestamptz,attempts=d.attempts+1
      from due where d.id=due.id returning d.id,d.storage_path,d.shop_id,d.trace_id,d.attempts`);
    await Promise.all(
      (rows as unknown as CleanupRow[]).map(async (row) => {
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
          const acknowledged = await db.execute(
            sql`delete from storage_object_deletions where id=${row.id}::uuid and lease_token=${token}::uuid returning id`,
          );
          if (acknowledged.length)
            context.info(
              { event: "storage_cleanup_deleted", attempt: row.attempts },
              "storage object deleted",
            );
        } catch {
          const retryAt = new Date(
            (this.options.now ?? (() => new Date()))().getTime() +
              Math.min(3600000, 1000 * 2 ** Math.min(row.attempts, 12)),
          );
          await db.execute(sql`update storage_object_deletions set lease_token=null,lease_until=null,next_attempt_at=${retryAt.toISOString()}::timestamptz
          where id=${row.id}::uuid and lease_token=${token}::uuid`);
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

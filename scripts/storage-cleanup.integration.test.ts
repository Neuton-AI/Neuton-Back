import "./support/testEnv.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema/index.js";
import {
  scheduleObjectDeletions,
  StorageCleanupDispatcher,
} from "../src/lib/storageCleanup.js";
import { CatalogDeletionPersistence } from "../src/modules/catalog/catalog-deletion.persistence.js";
import { LoggerImpl } from "../src/lib/logger/index.js";

const url = process.env.API_ALIGNMENT_TEST_DATABASE_URL;
test(
  "durable cleanup rolls back with deletion, leases competing workers, retries and recovers crashes",
  {
    skip: !url && "requires disposable API_ALIGNMENT_TEST_DATABASE_URL",
    timeout: 30000,
  },
  async () => {
    const namespace = `cleanup_${randomUUID().replaceAll("-", "")}`;
    const connection = postgres(url!, {
      max: 4,
      onnotice() {},
      connection: { search_path: namespace },
    });
    const shopId = randomUUID();
    const path = `${shopId}/recipe/page.jpg`;
    const events: Record<string, unknown>[] = [];
    const log = new LoggerImpl(
      {
        write: (_level, _message, meta) => {
          events.push(meta);
        },
      },
      {},
      "debug",
    );
    try {
      await connection.unsafe(`create schema ${namespace};
      create table ${namespace}.storage_object_deletions (like public.storage_object_deletions including all);
      create table ${namespace}.recipes (like public.recipes including all);
      create table ${namespace}.media_uploads (like public.media_uploads including all);
      alter table ${namespace}.media_uploads add foreign key(recipe_id) references ${namespace}.recipes(id) on delete cascade;
      create table ${namespace}.recipe_refs(recipe_id uuid references ${namespace}.recipes(id));`);
      const db = drizzle(connection, { schema });
      let now = Date.now() + 1000;
      const clock = () => new Date(now);
      const schedule = () =>
        scheduleObjectDeletions(db, {
          shopId,
          traceId: "cleanup-test",
          paths: [path, path],
        });
      const count = async () =>
        (
          await connection`select count(*)::int as count from storage_object_deletions`
        )[0]!.count;
      const observer = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        deleteObject: async () => {
          assert.fail("uncommitted intent must not be visible");
        },
      });
      await assert.rejects(
        db.transaction(async (tx) => {
          await scheduleObjectDeletions(tx, {
            shopId,
            traceId: "rollback",
            paths: [path],
          });
          assert.equal(await observer.drain(), 0);
          throw new Error("outer rollback");
        }),
        /outer rollback/,
      );
      assert.equal(await count(), 0);

      // FK refusal must be recovered with a savepoint inside the owning transaction.
      const recipeId = randomUUID();
      await connection`insert into recipes(id,shop_id,name,storage_path) values (${recipeId},${shopId},'Referenced',${path})`;
      await connection`insert into recipe_refs values (${recipeId})`;
      const deletion = new CatalogDeletionPersistence(db);
      await assert.rejects(
        db.transaction(async (tx) => {
          await new CatalogDeletionPersistence(tx).delete(
            shopId,
            recipeId,
            "rollback-delete",
          );
          throw new Error("rollback delete");
        }),
        /rollback delete/,
      );
      assert.equal(
        (
          await connection`select is_active from recipes where id=${recipeId}`
        )[0]?.is_active,
        true,
      );
      assert.equal(await count(), 0);
      assert.deepEqual(await deletion.delete(shopId, recipeId, "delete"), {
        ok: true,
        mode: "soft",
      });
      assert.equal(
        (
          await connection`select storage_path from recipes where id=${recipeId}`
        )[0]?.storage_path,
        null,
      );
      assert.equal(await count(), 1);

      let started!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const first = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        deleteObject: async () => {
          calls++;
          started();
          await gate;
        },
      });
      const second = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        deleteObject: async () => {
          calls++;
        },
      });
      const draining = first.drain();
      await entered;
      assert.equal(await second.drain(), 0);
      release();
      await draining;
      assert.equal(calls, 1);
      assert.equal(await count(), 0);

      await schedule();
      assert.equal(await count(), 1, "paths are deduplicated");
      const failing = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        deleteObject: async () => {
          throw new Error("private storage details");
        },
      });
      await failing.drain();
      assert.equal(await count(), 1);
      assert.equal(await second.drain(), 0, "retry waits for its due date");
      now += 5000;
      await second.drain();
      assert.equal(await count(), 0);

      await schedule();
      await connection`update storage_object_deletions set lease_token=${randomUUID()},lease_until=${new Date(now - 1).toISOString()}`;
      await second.drain();
      assert.equal(await count(), 0, "expired leases recover after restart");

      await schedule();
      const crashed = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        deleteObject: async () => {
          // Simulate a successful R2 delete followed by loss of the lease before DB ack.
          await connection`update storage_object_deletions set lease_token=${randomUUID()},lease_until=${new Date(now - 1).toISOString()}`;
        },
      });
      await crashed.drain();
      assert.equal(
        await count(),
        1,
        "stale owner cannot acknowledge another lease",
      );
      await second.drain();
      assert.equal(
        await count(),
        0,
        "already-absent R2 object can be deleted again safely",
      );
      await schedule();
      const timeout = new StorageCleanupDispatcher({
        db,
        log,
        now: clock,
        timeoutMs: 10,
        deleteObject: async () => new Promise<void>(() => {}),
      });
      await timeout.drain();
      assert.equal(await count(), 1, "timeouts retain durable work");
      assert.equal(
        JSON.stringify(events).includes("private storage details"),
        false,
      );
      assert.ok(
        events.some(
          (event) =>
            event.event === "storage_cleanup_retry" &&
            event.traceId === "cleanup-test",
        ),
      );
    } finally {
      await connection.unsafe(`drop schema if exists ${namespace} cascade`);
      await connection.end({ timeout: 5 });
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../src/db/client.js";
import { LoggerImpl } from "../src/lib/logger/index.js";
import { StorageCleanupDispatcher } from "../src/lib/storageCleanup.js";

test("cleanup dispatch logs the database error code from a wrapped failure", async () => {
  const cause = Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" });
  const db = {
    async execute() {
      throw new Error("query with sensitive parameters", { cause });
    },
  } as unknown as Database;
  const events: Record<string, unknown>[] = [];
  const log = new LoggerImpl(
    { write: (_level, _message, meta) => { events.push(meta); } },
    {},
    "debug",
  );
  const dispatcher = new StorageCleanupDispatcher({ db, log, deleteObject: async () => {} });

  dispatcher.start();
  try {
    await assert.rejects(dispatcher.drain());
    assert.deepEqual(events, [{
      event: "storage_cleanup_dispatch_failed",
      entryPoint: "storage_cleanup",
      errorType: "Error",
      errorCode: "ECONNREFUSED",
    }]);
  } finally {
    await dispatcher.stop();
  }
});

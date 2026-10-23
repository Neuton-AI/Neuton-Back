import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** No document/shop FK: cleanup must survive deletion of its originating rows. */
export const storageObjectDeletions = pgTable(
  "storage_object_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    storagePath: text("storage_path").notNull(),
    traceId: text("trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => ({
    pathUnique: uniqueIndex("storage_object_deletions_shop_path_unique").on(
      t.shopId,
      t.storagePath,
    ),
    dueIndex: index("storage_object_deletions_due_idx").on(
      t.nextAttemptAt,
      t.createdAt,
    ),
    attemptsCheck: check(
      "storage_object_deletions_attempts_check",
      sql`${t.attempts} >= 0`,
    ),
    leaseCheck: check(
      "storage_object_deletions_lease_check",
      sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`,
    ),
    tenantPath: check(
      "storage_object_deletions_tenant_path",
      sql`left(${t.storagePath}, 37) = ${t.shopId}::text || '/'`,
    ),
  }),
);

import { skipWithoutDisposableDatabase } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('pricing rollout invalidates initialized recipe revisions without changing tombstones or other kinds', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const { db, sql: connection } = await import('../src/db/client.js');
  try {
    await db.transaction(async (tx) => {
      const { sql } = await import('drizzle-orm');
      await tx.execute(sql.raw(`CREATE TEMP TABLE document_versions (
        kind text, updated_at bigint, deleted boolean
      ) ON COMMIT DROP;
      INSERT INTO document_versions VALUES
        ('recipe', 9999999999999, false), ('recipe', 100, true), ('order', 100, false);`));
      const migration = readFileSync(new URL('../drizzle/0039_recipe_order_pricing_sync.sql', import.meta.url), 'utf8');
      await tx.execute(sql.raw(migration));
      const rows = await tx.execute(sql`SELECT kind,updated_at::text,deleted FROM document_versions ORDER BY updated_at DESC`);
      assert.equal(rows[0]?.updated_at, '10000000000000', 'future revisions remain monotonic');
      assert.equal(rows[1]?.updated_at, '100');
      assert.equal(rows[2]?.updated_at, '100');
    });
  } finally {
    await connection.end({ timeout: 5 });
  }
});

import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';

test('the invitation migration preserves memberships and enforces the new storage rules', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const connection = postgres(testDatabaseUrl!, { onnotice: () => {} });
  try {
    await connection.begin(async (tx) => {
      await tx`CREATE SCHEMA invitation_migration_rehearsal`;
      await tx`SET LOCAL search_path TO invitation_migration_rehearsal, public`;
      await tx`CREATE TABLE users (LIKE public.users INCLUDING ALL)`;
      await tx`CREATE TABLE shops (LIKE public.shops INCLUDING ALL)`;
      await tx`CREATE TABLE shop_members (LIKE public.shop_members INCLUDING ALL)`;

      const [shop] = await tx<{ id: string }[]>`
        INSERT INTO shops (name, slug) VALUES ('Prior Shop', 'prior-shop') RETURNING id
      `;
      const accounts = await tx<{ id: string }[]>`
        INSERT INTO users (email) VALUES ('owner@example.test'), ('admin@example.test'),
          ('member@example.test'), ('invitee@example.test'), ('other@example.test') RETURNING id
      `;
      const [owner, admin, member, invitee, other] = accounts;
      assert.ok(shop && owner && admin && member && invitee && other);
      await tx`INSERT INTO shop_members (shop_id, user_id, role) VALUES
        (${shop.id}, ${owner.id}, 'owner'), (${shop.id}, ${admin.id}, 'admin'),
        (${shop.id}, ${member.id}, 'member')`;
      const memberships = await tx`SELECT id, user_id, role FROM shop_members ORDER BY id`;

      const migration = await readFile(new URL('../drizzle/0044_shop_invitations.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        await tx.unsafe(statement.trim());
      }
      assert.deepEqual(await tx`SELECT id, user_id, role FROM shop_members ORDER BY id`, memberships);

      const insertInvite = (sql: typeof tx, recipientId: string, role = 'member') => sql`
        INSERT INTO shop_invitations (shop_id, recipient_id, offered_role)
        VALUES (${shop.id}, ${recipientId}, ${role}) RETURNING status, read_at, resolved_at
      `;
      const [pending] = await insertInvite(tx, invitee.id);
      assert.deepEqual(pending, { status: 'pending', read_at: null, resolved_at: null });
      await assert.rejects(tx.savepoint((sql) => insertInvite(sql, invitee.id, 'admin')), { code: '23505' });
      await assert.rejects(tx.savepoint((sql) => insertInvite(sql, other.id, 'owner')), { code: '23514' });
      await tx`UPDATE shop_invitations SET status = 'declined', resolved_at = now() WHERE recipient_id = ${invitee.id}`;
      await insertInvite(tx, invitee.id, 'admin');
      await insertInvite(tx, other.id);

      await tx`DELETE FROM users WHERE id = ${invitee.id}`;
      const remaining = await tx<{ recipient_id: string }[]>`SELECT recipient_id FROM shop_invitations`;
      assert.deepEqual(remaining.map((row) => row.recipient_id), [other.id]);
      await tx`DELETE FROM shops WHERE id = ${shop.id}`;
      const afterShopDelete = await tx`SELECT id FROM shop_invitations`;
      assert.equal(afterShopDelete.length, 0);
      await tx`DROP SCHEMA invitation_migration_rehearsal CASCADE`;
    });
  } finally {
    await connection.end();
  }
});

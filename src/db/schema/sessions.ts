import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secretDigest: varchar('secret_digest', { length: 64 }).notNull(),
  securityVersion: integer('security_version').notNull(),
  signInMethod: text('sign_in_method', { enum: ['password', 'google'] }).notNull().default('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revocationReason: varchar('revocation_reason', { length: 40 }),
  deviceLabel: varchar('device_label', { length: 120 }),
}, (t) => ({
  digestUnique: uniqueIndex('user_sessions_secret_digest_unique').on(t.secretDigest),
  ownerIdx: index('user_sessions_user_id_idx').on(t.userId),
  signInMethodCheck: check('user_sessions_sign_in_method_check', sql`${t.signInMethod} IN ('password', 'google')`),
  expiryIdx: index('user_sessions_effective_expiry_idx')
    .on(sql`least(${t.idleExpiresAt}, ${t.absoluteExpiresAt}, ${t.revokedAt})`),
}));

export const preAuthContexts = pgTable('pre_auth_contexts', {
  secretDigest: varchar('secret_digest', { length: 64 }).primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  expiryIdx: index('pre_auth_contexts_expires_at_idx').on(t.expiresAt),
}));

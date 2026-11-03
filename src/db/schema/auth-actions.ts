import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { authPrivate, authUsers } from './auth.js';

export const actionTokens = authPrivate.table('action_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: ['confirm_email', 'password_reset', 'email_change'] }).notNull(),
  tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
  intendedEmail: varchar('intended_email', { length: 320 }),
  securityVersion: integer('security_version').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
}, table => ({
  digestUnique: uniqueIndex('action_tokens_digest_unique').on(table.tokenDigest),
  userPurpose: index('action_tokens_user_purpose_idx').on(table.userId, table.purpose),
  expiry: index('action_tokens_expiry_idx').on(table.expiresAt),
  purpose: check('action_tokens_purpose_check', sql`${table.purpose} in ('confirm_email','password_reset','email_change')`),
  version: check('action_tokens_version_check', sql`${table.securityVersion} >= 1`),
  digest: check('action_tokens_digest_check', sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$'`),
  email: check('action_tokens_email_check', sql`${table.purpose} = 'password_reset' or ${table.intendedEmail} is not null`),
  lifetime: check('action_tokens_lifetime_check', sql`${table.issuedAt} < ${table.expiresAt}`),
}));

export const browserContexts = authPrivate.table('browser_contexts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
  csrfDigest: varchar('csrf_digest', { length: 64 }).notNull(),
  environment: varchar('environment', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => ({
  digestUnique: uniqueIndex('browser_contexts_digest_unique').on(table.tokenDigest),
  expiry: index('browser_contexts_expiry_idx').on(table.expiresAt),
  digests: check('browser_contexts_digests_check', sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$' and ${table.csrfDigest} ~ '^[a-f0-9]{64}$'`),
  lifetime: check('browser_contexts_lifetime_check', sql`${table.createdAt} < ${table.expiresAt}`),
}));

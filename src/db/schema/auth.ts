import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const authPrivate = pgSchema('auth_private');

export const authUsers = authPrivate.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull(),
  normalizedEmail: varchar('normalized_email', { length: 320 }).notNull(),
  emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true }),
  status: text('status', { enum: ['pending_email', 'active', 'disabled'] }).notNull().default('pending_email'),
  securityVersion: integer('security_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  emailUnique: uniqueIndex('users_normalized_email_unique').on(table.normalizedEmail),
  status: check('users_status_check', sql`${table.status} in ('pending_email','active','disabled')`),
  version: check('users_security_version_check', sql`${table.securityVersion} >= 1`),
  activeConfirmed: check('users_active_confirmed_check', sql`${table.status} <> 'active' or ${table.emailConfirmedAt} is not null`),
}));

export const passwordCredentials = authPrivate.table('password_credentials', {
  userId: uuid('user_id').primaryKey().references(() => authUsers.id, { onDelete: 'cascade' }),
  encodedHash: text('encoded_hash').notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const googleIdentities = authPrivate.table('google_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  subject: varchar('subject', { length: 255 }).notNull(),
  observedEmail: varchar('observed_email', { length: 320 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
}, table => ({
  subjectUnique: uniqueIndex('google_identities_issuer_subject_unique').on(table.issuer, table.subject),
  userUnique: uniqueIndex('google_identities_user_unique').on(table.userId),
  issuer: check('google_identities_issuer_check', sql`${table.issuer} = 'https://accounts.google.com'`),
  subject: check('google_identities_subject_check', sql`length(${table.subject}) > 0`),
}));

export const authSessions = authPrivate.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
  securityVersion: integer('security_version').notNull(),
  authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),
  authenticationMethod: text('authentication_method', { enum: ['password', 'google'] }).notNull(),
  recentAuthenticatedAt: timestamp('recent_authenticated_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: varchar('revoked_reason', { length: 80 }),
  csrfDigest: varchar('csrf_digest', { length: 64 }).notNull(),
  userAgent: varchar('user_agent', { length: 256 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  digestUnique: uniqueIndex('sessions_token_digest_unique').on(table.tokenDigest),
  user: index('sessions_user_idx').on(table.userId),
  expiry: index('sessions_absolute_expiry_idx').on(table.absoluteExpiresAt),
  idle: index('sessions_idle_expiry_idx').on(table.idleExpiresAt),
  version: check('sessions_security_version_check', sql`${table.securityVersion} >= 1`),
  digest: check('sessions_digests_check', sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$' and ${table.csrfDigest} ~ '^[a-f0-9]{64}$'`),
  method: check('sessions_method_check', sql`${table.authenticationMethod} in ('password','google')`),
  lifetime: check('sessions_lifetime_check', sql`${table.authenticatedAt} <= ${table.lastActivityAt} and ${table.lastActivityAt} < ${table.idleExpiresAt} and ${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`),
}));

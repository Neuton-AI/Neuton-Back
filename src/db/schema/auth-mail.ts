import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { authPrivate, authSessions, authUsers } from './auth.js';
import { actionTokens } from './auth-actions.js';

export const securityEvents = authPrivate.table('security_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  subjectUserId: uuid('subject_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => authSessions.id, { onDelete: 'set null' }),
  event: varchar('event', { length: 80 }).notNull(),
  result: text('result', { enum: ['success', 'denied', 'failed'] }).notNull(),
  correlationId: varchar('correlation_id', { length: 128 }).notNull(),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  subjectTime: index('security_events_subject_time_idx').on(table.subjectUserId, table.createdAt),
  retention: index('security_events_created_at_idx').on(table.createdAt),
  result: check('security_events_result_check', sql`${table.result} in ('success','denied','failed')`),
  metadata: check('security_events_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object' and octet_length(${table.metadata}::text) <= 4096`),
}));

export const mailOutbox = authPrivate.table('mail_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  purpose: text('purpose', { enum: ['confirm_email', 'password_reset', 'email_change', 'security_notice'] }).notNull(),
  destination: varchar('destination', { length: 320 }).notNull(),
  encryptedPayload: text('encrypted_payload'),
  payloadKeyId: varchar('payload_key_id', { length: 64 }),
  actionTokenId: uuid('action_token_id').references(() => actionTokens.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastErrorCode: varchar('last_error_code', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
}, table => ({
  due: index('mail_outbox_due_idx').on(table.nextAttemptAt, table.createdAt)
    .where(sql`${table.sentAt} is null and ${table.discardedAt} is null`),
  expiry: index('mail_outbox_expiry_idx').on(table.expiresAt),
  token: index('mail_outbox_action_token_idx').on(table.actionTokenId),
  purpose: check('mail_outbox_purpose_check', sql`${table.purpose} in ('confirm_email','password_reset','email_change','security_notice')`),
  action: check('mail_outbox_action_check', sql`${table.purpose} = 'security_notice' or ${table.actionTokenId} is not null`),
  attempts: check('mail_outbox_attempts_check', sql`${table.attempts} >= 0`),
  lease: check('mail_outbox_lease_check', sql`(${table.leaseToken} is null) = (${table.leaseUntil} is null)`),
  encryption: check('mail_outbox_encryption_check', sql`(${table.encryptedPayload} is null) = (${table.payloadKeyId} is null)`),
  pendingPayload: check('mail_outbox_pending_payload_check', sql`${table.sentAt} is not null or ${table.discardedAt} is not null or ${table.encryptedPayload} is not null`),
  lifetime: check('mail_outbox_lifetime_check', sql`${table.createdAt} < ${table.expiresAt}`),
}));

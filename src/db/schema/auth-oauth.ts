import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { authPrivate, authSessions, authUsers } from './auth.js';
import { browserContexts } from './auth-actions.js';

export const oauthTransactions = authPrivate.table('oauth_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  stateDigest: varchar('state_digest', { length: 64 }).notNull(),
  browserContextId: uuid('browser_context_id').notNull().references(() => browserContexts.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: ['login', 'link', 'reauthenticate'] }).notNull(),
  initiatingUserId: uuid('initiating_user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
  initiatingSessionId: uuid('initiating_session_id').references(() => authSessions.id, { onDelete: 'cascade' }),
  expectedSecurityVersion: integer('expected_security_version'),
  nonce: varchar('nonce', { length: 128 }).notNull(),
  encryptedVerifier: text('encrypted_verifier'),
  verifierKeyId: varchar('verifier_key_id', { length: 64 }),
  returnPath: varchar('return_path', { length: 256 }).notNull(),
  status: text('status', { enum: ['pending', 'claimed', 'completed', 'failed'] }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
}, table => ({
  stateUnique: uniqueIndex('oauth_transactions_state_unique').on(table.stateDigest),
  browser: index('oauth_transactions_browser_idx').on(table.browserContextId, table.createdAt),
  expiry: index('oauth_transactions_expiry_idx').on(table.expiresAt),
  digest: check('oauth_transactions_digest_check', sql`${table.stateDigest} ~ '^[a-f0-9]{64}$'`),
  purpose: check('oauth_transactions_purpose_check', sql`${table.purpose} in ('login','link','reauthenticate')`),
  status: check('oauth_transactions_status_check', sql`${table.status} in ('pending','claimed','completed','failed')`),
  initiator: check('oauth_transactions_initiator_check', sql`(${table.purpose} = 'login' and ${table.initiatingUserId} is null and ${table.initiatingSessionId} is null and ${table.expectedSecurityVersion} is null) or (${table.purpose} <> 'login' and ${table.initiatingUserId} is not null and ${table.initiatingSessionId} is not null and ${table.expectedSecurityVersion} is not null and ${table.expectedSecurityVersion} >= 1)`),
  encryption: check('oauth_transactions_encryption_check', sql`(${table.encryptedVerifier} is null) = (${table.verifierKeyId} is null)`),
  lifetime: check('oauth_transactions_lifetime_check', sql`${table.createdAt} < ${table.expiresAt}`),
}));

export interface CompletionIdentity {
  issuer: 'https://accounts.google.com';
  subject: string;
  observedEmail: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  authenticatedAt: string | null;
}

export const oauthCompletions = authPrivate.table('oauth_completions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketDigest: varchar('ticket_digest', { length: 64 }).notNull(),
  transactionId: uuid('transaction_id').notNull().references(() => oauthTransactions.id, { onDelete: 'cascade' }),
  targetUserId: uuid('target_user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
  candidateUserId: uuid('candidate_user_id'),
  identity: jsonb('identity').$type<CompletionIdentity>().notNull(),
  expectedSecurityVersion: integer('expected_security_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, table => ({
  digestUnique: uniqueIndex('oauth_completions_ticket_unique').on(table.ticketDigest),
  transactionUnique: uniqueIndex('oauth_completions_transaction_unique').on(table.transactionId),
  expiry: index('oauth_completions_expiry_idx').on(table.expiresAt),
  digest: check('oauth_completions_digest_check', sql`${table.ticketDigest} ~ '^[a-f0-9]{64}$'`),
  target: check('oauth_completions_target_check', sql`num_nonnulls(${table.targetUserId},${table.candidateUserId}) = 1`),
  version: check('oauth_completions_version_check', sql`${table.expectedSecurityVersion} >= 1`),
  identity: check('oauth_completions_identity_check', sql`jsonb_typeof(${table.identity}) = 'object' and octet_length(${table.identity}::text) <= 4096`),
  identityFields: check('oauth_completions_identity_fields_check', sql`${table.identity} ?& array['issuer','subject'] and ${table.identity}->>'issuer' = 'https://accounts.google.com' and length(${table.identity}->>'subject') > 0 and (${table.identity} - array['issuer','subject','observedEmail','emailVerified','displayName','avatarUrl','authenticatedAt']::text[]) = '{}'::jsonb`),
  lifetime: check('oauth_completions_lifetime_check', sql`${table.createdAt} < ${table.expiresAt}`),
}));

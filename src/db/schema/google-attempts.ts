import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import type { GoogleIdentity } from '../../modules/identity/google-oidc.js';
import { preAuthContexts, userSessions } from './sessions.js';

export type GoogleCompletionProof = {
  identity: GoogleIdentity;
  observedLink: { userId: string; revision: number } | null;
};

export const googleAttempts = pgTable('google_attempts', {
  stateDigest: varchar('state_digest', { length: 64 }).primaryKey(),
  contextDigest: varchar('context_digest', { length: 64 }).references(() => preAuthContexts.secretDigest, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => userSessions.id, { onDelete: 'cascade' }),
  linkRevision: integer('link_revision'),
  nonce: varchar('nonce', { length: 43 }),
  encryptedVerifier: text('encrypted_verifier'),
  completionDigest: varchar('completion_digest', { length: 64 }),
  completionProof: jsonb('completion_proof').$type<GoogleCompletionProof>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  contextExpiry: index('google_attempts_context_expiry_idx').on(t.contextDigest, t.expiresAt),
  sessionExpiry: index('google_attempts_session_expiry_idx').on(t.sessionId, t.expiresAt),
  expiry: index('google_attempts_expiry_idx').on(t.expiresAt, t.stateDigest),
  completionUnique: uniqueIndex('google_attempts_completion_unique').on(t.completionDigest),
  binding: check('google_attempts_binding_check', sql`
    (${t.contextDigest} IS NOT NULL AND ${t.sessionId} IS NULL AND ${t.linkRevision} IS NULL) OR
    (${t.contextDigest} IS NULL AND ${t.sessionId} IS NOT NULL AND ${t.linkRevision} IS NOT NULL)`),
  proof: check('google_attempts_proof_check', sql`
    (${t.nonce} IS NULL) = (${t.encryptedVerifier} IS NULL) AND
    (${t.completionDigest} IS NULL) = (${t.completionProof} IS NULL) AND
    (${t.completionDigest} IS NULL OR ${t.encryptedVerifier} IS NULL)`),
})).enableRLS();

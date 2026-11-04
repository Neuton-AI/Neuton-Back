import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgSchema, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { authUsers } from './auth.js';
import { shops } from './identity.js';
import { mediaUploads } from './uploads.js';

export const appPrivate = pgSchema('app_private');
export const USER_PROCESSING_OPERATIONS = ['extract_receipt', 'extract_recipe', 'extract_order', 'extract_product'] as const;
export type UserProcessingOperation = (typeof USER_PROCESSING_OPERATIONS)[number];

// Cleanup uses its own role/routines. No general system-job authority is enabled.
export const SYSTEM_MAINTENANCE_OPERATIONS: readonly string[] = Object.freeze([]);

export const jobAuthorizations = appPrivate.table('job_authorizations', {
  jobId: varchar('job_id', { length: 200 }).primaryKey(),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  requestingUserId: uuid('requesting_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  uploadId: uuid('upload_id').notNull(),
  resourceKind: text('resource_kind', { enum: ['receipt', 'recipe', 'order', 'upload'] }).notNull(),
  resourceId: uuid('resource_id').notNull(),
  operation: text('operation', { enum: USER_PROCESSING_OPERATIONS }).notNull(),
  sourcesDigest: varchar('sources_digest', { length: 64 }).notNull(),
  state: text('state', { enum: ['accepted', 'queued', 'processing', 'completed', 'failed', 'cancelled'] }).notNull().default('accepted'),
  correlationId: varchar('correlation_id', { length: 128 }).notNull(),
  resourceRevision: bigint('resource_revision', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancellationReason: varchar('cancellation_reason', { length: 80 }),
}, table => ({
  uploadUnique: uniqueIndex('job_authorizations_upload_unique').on(table.uploadId),
  uploadTenant: foreignKey({ name: 'job_upload_shop_fk', columns: [table.shopId, table.uploadId],
    foreignColumns: [mediaUploads.shopId, mediaUploads.id] }).onDelete('cascade'),
  shopResource: index('job_authorizations_resource_idx').on(table.shopId, table.resourceKind, table.resourceId),
  expiry: index('job_authorizations_expiry_idx').on(table.expiresAt),
  publication: index('job_authorizations_publication_idx').on(table.createdAt).where(sql`${table.state} = 'accepted'`),
  identity: check('job_authorizations_identity_check', sql`${table.jobId} = 'upload-' || ${table.uploadId}::text`),
  sources: check('job_authorizations_sources_check', sql`${table.sourcesDigest} ~ '^[a-f0-9]{64}$'`),
  operation: check('job_authorizations_operation_check', sql`
    (${table.operation} = 'extract_receipt' and ${table.resourceKind} = 'receipt') or
    (${table.operation} = 'extract_recipe' and ${table.resourceKind} = 'recipe') or
    (${table.operation} = 'extract_order' and ${table.resourceKind} = 'order') or
    (${table.operation} = 'extract_product' and ${table.resourceKind} = 'upload' and ${table.resourceId} = ${table.uploadId})`),
  state: check('job_authorizations_state_check', sql`${table.state} in ('accepted','queued','processing','completed','failed','cancelled')`),
  cancellation: check('job_authorizations_cancellation_check', sql`${table.state} <> 'cancelled' or ${table.cancelledAt} is not null`),
  lifetime: check('job_authorizations_lifetime_check', sql`${table.createdAt} < ${table.expiresAt}`),
})).enableRLS();

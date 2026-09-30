import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

export type AuditEvent =
  | 'SHOP_CREATED'
  | 'SHOP_UPDATED'
  | 'RECEIPT_UPLOAD'
  | 'RECEIPT_PROCESSED'
  | 'RECEIPT_FAILED'
  | 'ORDER_CREATED'
  | 'RECIPE_CREATED'
  | 'RECIPE_UPDATED'
  | 'INVENTORY_UPDATED'
  | 'PASSWORD_CHANGED'
  | 'TWO_FACTOR_CHANGED';

export interface AuditInput {
  shopId: string;
  userId: string | null;
  eventType: AuditEvent;
  resourceId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Structured security/event trail written to `audit_logs` (and mirrored to Pino). */
export async function recordAudit(input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    shopId: input.shopId,
    userId: input.userId,
    eventType: input.eventType,
    resourceId: input.resourceId ?? null,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
  });
}

export async function recordAuditSafe(app: FastifyInstance, input: AuditInput): Promise<void> {
  try {
    await recordAudit(input);
  } catch (error) {
    app.log.error({ err: error, eventType: input.eventType }, 'audit write failed');
  }
}

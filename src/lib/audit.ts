import { db, type Database } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

export type AuditEvent =
  | 'SHOP_CREATED'
  | 'SHOP_UPDATED'
  | 'RECEIPT_UPLOAD'
  | 'RECEIPT_PROCESSED'
  | 'RECEIPT_UPDATED'
  | 'RECEIPT_DELETED'
  | 'ORDER_CREATED'
  | 'ORDER_UPDATED'
  | 'ORDER_DELIVERED'
  | 'ORDER_DELIVERY_UNDONE'
  | 'ORDER_CANCELLED'
  | 'RECIPE_CREATED'
  | 'RECIPE_UPDATED'
  | 'RECIPE_DELETED'
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
export async function recordAudit(input: AuditInput, database: Pick<Database, 'insert'> = db): Promise<void> {
  await database.insert(auditLogs).values({
    shopId: input.shopId,
    userId: input.userId,
    eventType: input.eventType,
    resourceId: input.resourceId ?? null,
    ipAddress: input.ipAddress ?? null,
    metadata: input.metadata ?? null,
  });
}

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { shops, users } from './identity.js';

export const INVITABLE_SHOP_ROLES = ['member', 'admin'] as const;
const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'canceled'] as const;

export const shopInvitations = pgTable('shop_invitations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id').notNull().references(() => shops.id, { onDelete: 'cascade' }),
  recipientId: uuid('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  offeredRole: text('offered_role', { enum: INVITABLE_SHOP_ROLES }).notNull(),
  status: text('status', { enum: INVITATION_STATUSES }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => ({
  pendingUnique: uniqueIndex('shop_invitations_pending_unique')
    .on(t.shopId, t.recipientId)
    .where(sql`${t.status} = 'pending'`),
  shopIdx: index('shop_invitations_shop_id_idx').on(t.shopId),
  recipientIdx: index('shop_invitations_recipient_id_idx').on(t.recipientId),
  offeredRoleCheck: check('shop_invitations_offered_role', sql`${t.offeredRole} IN ('member', 'admin')`),
  statusCheck: check('shop_invitations_status', sql`${t.status} IN ('pending', 'accepted', 'declined', 'canceled')`),
  resolutionCheck: check('shop_invitations_resolution', sql`(${t.status} = 'pending') = (${t.resolvedAt} IS NULL)`),
})).enableRLS();

import { sql } from 'drizzle-orm';
import {
  char,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { SHOP_ROLES } from './enums.js';

export const shops = pgTable('shops', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('USD'),
  timezone: text('timezone').notNull().default('UTC'),
  storeAddress: text('store_address'),
  targetProfitMargin: numeric('target_profit_margin', { precision: 5, scale: 2 })
    .notNull()
    .default('0.00'),
  hourlyLaborCost: numeric('hourly_labor_cost', { precision: 10, scale: 2 })
    .notNull()
    .default('0.00'),
  deliveryBaseFee: numeric('delivery_base_fee', { precision: 10, scale: 2 })
    .notNull()
    .default('0.00'),
  deliveryRatePerKm: numeric('delivery_rate_per_km', { precision: 10, scale: 2 })
    .notNull()
    .default('0.00'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUnique: uniqueIndex('shops_slug_unique').on(t.slug),
}));

export const profiles = pgTable('profiles', {
  // FK to auth.users(id) is added in the hand-written auth/RLS migration so the
  // generated schema never tries to create Supabase's native auth table.
  id: uuid('id').primaryKey(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopMembers = pgTable('shop_members', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  role: text('role', { enum: SHOP_ROLES }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopUserUnique: uniqueIndex('shop_members_shop_id_user_id_unique').on(t.shopId, t.userId),
  userIdx: index('shop_members_user_id_idx').on(t.userId),
}));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  ipAddress: varchar('ip_address', { length: 45 }),
  eventType: text('event_type').notNull(),
  resourceId: uuid('resource_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shopCreatedIdx: index('audit_logs_shop_id_created_at_idx').on(t.shopId, t.createdAt),
}));

export type Shop = typeof shops.$inferSelect;
export type NewShop = typeof shops.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type ShopMember = typeof shopMembers.$inferSelect;
export type NewShopMember = typeof shopMembers.$inferInsert;

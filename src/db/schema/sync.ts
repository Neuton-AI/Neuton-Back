import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { shops } from './identity.js';

export const documentVersions = pgTable(
  'document_versions',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['receipt', 'recipe', 'order'] }).notNull(),
    id: uuid('id').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    deleted: boolean('deleted').notNull().default(false),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.shopId, table.kind, table.id] }),
  }),
);

export const documentMutations = pgTable(
  'document_mutations',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    userId: uuid('user_id').notNull(),
    request: jsonb('request').notNull(),
    response: jsonb('response'),
    status: integer('status').notNull().default(200),
  },
  (table) => ({ primary: primaryKey({ columns: [table.shopId, table.id] }) }),
);

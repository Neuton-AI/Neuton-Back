import type { Database } from './client.js';
import type { ShopRole } from './schema/enums.js';
export type ReadDatabase = Pick<Database, 'select'>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type TransactionalDatabase = Database | DatabaseTransaction;

export interface UserTransaction<TDatabase = DatabaseTransaction> {
  readonly scope: 'user';
  readonly database: TDatabase;
  readonly userId: string;
  readonly sessionId: string;
}
export interface ShopTransaction<TDatabase = DatabaseTransaction> {
  readonly scope: 'shop';
  readonly database: TDatabase;
  readonly userId: string;
  readonly sessionId: string;
  readonly shopId: string;
  readonly role: ShopRole;
}

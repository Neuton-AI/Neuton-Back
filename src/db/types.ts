import type { Database } from './client.js';
export type ReadDatabase = Pick<Database, 'select'>;
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type TransactionalDatabase = Database | DatabaseTransaction;

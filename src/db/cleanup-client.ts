import { drizzle } from 'drizzle-orm/postgres-js';
import type { EnvironmentSource } from '../config/database.js';
import { createDatabaseConnection } from './connection.js';
import { storageObjectDeletions } from './schema/storage-cleanup.js';

export function createCleanupDatabase(source: EnvironmentSource = process.env) {
  const connection = createDatabaseConnection('cleanup', source);
  const database = drizzle(connection, { schema: { storageObjectDeletions } });
  return { database, connection, close: () => connection.end({ timeout: 5 }) };
}

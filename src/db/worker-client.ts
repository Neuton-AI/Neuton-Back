import { drizzle } from 'drizzle-orm/postgres-js';
import type { EnvironmentSource } from '../config/database.js';
import { createDatabaseConnection } from './connection.js';
import * as schema from './schema/index.js';

export function createWorkerDatabase(source: EnvironmentSource = process.env) {
  const connection = createDatabaseConnection('worker', source);
  const database = drizzle(connection, { schema });
  return { database, connection, close: () => connection.end({ timeout: 5 }) };
}

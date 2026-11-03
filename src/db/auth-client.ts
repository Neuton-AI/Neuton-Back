import { drizzle } from 'drizzle-orm/postgres-js';
import type { EnvironmentSource } from '../config/database.js';
import { createDatabaseConnection } from './connection.js';
import * as schema from './schema/auth-index.js';

/** Private lifecycle code only; never import from business persistence. */
export function createAuthDatabase(source: EnvironmentSource = process.env) {
  const connection = createDatabaseConnection('auth', source);
  const database = drizzle(connection, { schema });
  return { database, connection, close: () => connection.end({ timeout: 5 }) };
}

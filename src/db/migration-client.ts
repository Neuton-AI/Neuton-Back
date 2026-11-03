import type { EnvironmentSource } from '../config/database.js';
import { createDatabaseConnection } from './connection.js';

/** No API environment, business schema, Redis or storage initialization. */
export function createMigrationConnection(source: EnvironmentSource = process.env) {
  return createDatabaseConnection('migration', source);
}

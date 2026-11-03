import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../env.js';
import * as schema from './schema/index.js';
import { createDatabaseConnection } from './connection.js';
import type postgres from 'postgres';

export const sql = createDatabaseConnection('app', { DATABASE_URL: env.DATABASE_URL });

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export type DatabaseClient = postgres.Sql;
export { schema };

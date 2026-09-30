import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema/index.js';

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export type DatabaseClient = postgres.Sql;
export { schema };

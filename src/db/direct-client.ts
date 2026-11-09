import postgres from 'postgres';
import { env } from '../env.js';
import { resolveDirectDatabaseUrl } from './direct-database-url.js';

export const directSql = postgres(resolveDirectDatabaseUrl(env.DATABASE_URL, env.DIRECT_DATABASE_URL), {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,
  onnotice: () => {},
});

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolveDirectDatabaseUrl } from './src/db/direct-database-url.js';

if (process.env.NEUTON_SKIP_ENV_FILES !== '1') {
  loadDotenv();
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/neuton';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: resolveDirectDatabaseUrl(databaseUrl, process.env.DIRECT_DATABASE_URL) },
  verbose: true,
  strict: true,
});

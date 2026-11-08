import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

if (process.env.NEUTON_SKIP_ENV_FILES !== '1') {
  loadDotenv();
}

const url =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/neuton';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});

import { defineConfig } from 'drizzle-kit';
import { readAuthConfig } from './src/config/auth.js';

const { databaseUrl: url } = readAuthConfig('migration');

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle-neon',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});

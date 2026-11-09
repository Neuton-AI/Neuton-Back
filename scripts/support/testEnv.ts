/**
 * Test bootstrap. Import this **first** in every test file: it runs before the
 * application modules, which validate their environment at import time.
 *
 * The PostgreSQL runner supplies a disposable database. All other database
 * URLs are replaced before the application can import its configuration.
 */
function disposableUrl(url: string | undefined) {
  return url && /^postgresql:\/\/neuton_test_runner:[0-9a-f]{48}@127\.0\.0\.1:[1-9]\d{0,4}\/neuton_disposable$/.test(url)
    ? url
    : undefined;
}

export const testDatabaseUrl = disposableUrl(process.env.DATABASE_URL);
export const skipWithoutDisposableDatabase = !testDatabaseUrl && 'run npm run test:postgres';

process.env.NEUTON_SKIP_ENV_FILES = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl ?? 'postgresql://unused@127.0.0.1:1/unused';
process.env.DIRECT_DATABASE_URL = disposableUrl(process.env.DIRECT_DATABASE_URL) ?? process.env.DATABASE_URL;

const PLACEHOLDERS: Record<string, string> = {
  UPSTASH_REDIS_URL: 'redis://localhost:6379',
  R2_ACCOUNT_ID: 'placeholder-account',
  R2_ACCESS_KEY_ID: 'placeholder-access-key',
  R2_SECRET_ACCESS_KEY: 'placeholder-secret-key',
  R2_BUCKET_NAME: 'neuton-receipts-test',
  GEMINI_API_KEY: 'placeholder-gemini-key',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  if (process.env[key]) continue;
  process.env[key] = value;
}

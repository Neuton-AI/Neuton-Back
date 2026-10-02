/**
 * Test bootstrap. Import this **first** in every test file: it runs before the
 * application modules, which validate their environment at import time.
 *
 * A real `.env` is honoured so the database-backed tests still reach a real
 * database locally, but anything still missing is filled with an inert
 * placeholder so `npm test` never needs a secret to run. Tests that require a
 * real service check `placeholderKeys` rather than silently passing.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

process.env.NODE_ENV = 'test';

const PLACEHOLDERS: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/neuton_test',
  SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
  UPSTASH_REDIS_URL: 'redis://localhost:6379',
  R2_ACCOUNT_ID: 'placeholder-account',
  R2_ACCESS_KEY_ID: 'placeholder-access-key',
  R2_SECRET_ACCESS_KEY: 'placeholder-secret-key',
  R2_BUCKET_NAME: 'neuton-receipts-test',
  GEMINI_API_KEY: 'placeholder-gemini-key',
};

/** Config keys that had to be faked, so no test can talk to a real service. */
export const placeholderKeys: string[] = [];

const definedBeforeFaking = new Set(Object.keys(process.env));

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  if (process.env[key]) continue;
  process.env[key] = value;
  placeholderKeys.push(key);
}

/**
 * True when `key` was set by whoever ran the suite, not by the placeholders
 * above. A test that needs a live service asserts on this instead of on the
 * presence of the variable, which is always set after the loop above.
 */
export function wasConfigured(key: string): boolean {
  return definedBeforeFaking.has(key) && !placeholderKeys.includes(key);
}

/** True when no `.env` or shell export supplied `key` — i.e. nothing real. */
export function isPlaceholder(key: string): boolean {
  return placeholderKeys.includes(key);
}
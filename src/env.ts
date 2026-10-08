import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

/** Treats unset or blank values as "not configured" so `.env` stubs stay valid. */
const emptyToUndefined = (schema: z.ZodString) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SUPABASE_URL: z.string().url().min(1, 'SUPABASE_URL is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  UPSTASH_REDIS_URL: z.string().min(1, 'UPSTASH_REDIS_URL is required'),

  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET_NAME: z.string().min(1, 'R2_BUCKET_NAME is required'),

  GRAFANA_LOG_URL: z.string().url().default('http://localhost:9999/loki/api/v1/push'),
  /** Bearer token for the Loki push endpoint (Grafana Cloud). Unset/empty disables Loki shipping. */
  GRAFANA_LOKI_TOKEN: emptyToUndefined(z.string()),
  /** Stream label for the Loki `environment` label. Defaults from NODE_ENV. */
  LOG_ENV: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['development', 'staging', 'production']).optional(),
  ),
  /** Release identifier attached to every log line. Falls back to GIT_SHA, then `dev`. */
  APP_VERSION: emptyToUndefined(z.string()),
  /** Commit sha provided by CI; picked up when APP_VERSION is unset. */
  GIT_SHA: emptyToUndefined(z.string()),

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

  /**
   * Vision models in fallback order. Comma separated; the first is the default
   * and each failure advances to the next one.
   */
  GEMINI_MODELS: z
    .string()
    .default(
      [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite-preview',
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-pro',
        'gemma-4-26b-a4b-it',
      ].join(','),
    ),

  /** Origins allowed to call the API with credentials. Comma separated. */
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  /** Presigned R2 upload lifetime in seconds. */
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Hard cap on a single uploaded receipt document, in bytes. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  /** Global API rate limit (requests per window). */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** BullMQ concurrency for the receipt vision pipeline. */
  RECEIPT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Max time (ms) a single Gemini API call may take before aborting. */
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Max time (ms) a BullMQ job may hold a worker slot (lockDuration). 2.5 min per attempt. */
  JOB_LOCK_DURATION_MS: z.coerce.number().int().positive().default(2.5 * 60 * 1000),
  /** Max time (ms) a BullMQ job may run before being forcibly stalled. */
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(2.5 * 60 * 1000),
  /** Max time (ms) a database query may run before timing out. */
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Max time (ms) a receipt can spend in processing before being marked as failed. 5 min total (2 attempts x 2.5 min). */
  RECEIPT_PROCESSING_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  /** Circuit breaker: trip after this many consecutive Gemini failures across all jobs. */
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(10),
  /** Circuit breaker: time (ms) to keep the circuit open before allowing a probe request. */
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().positive().default(60_000),
  /** Allow the queue to be used when Redis is unreachable (dev convenience). */
  QUEUE_OPTIONAL: boolish.default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
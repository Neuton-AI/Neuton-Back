import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

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

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

  /**
   * Vision models tried in order when one is out of capacity. Comma separated;
   * the first is the default and each retry rotates to the next.
   */
  GEMINI_MODELS: z
    .string()
    .default('gemini-2.0-flash,gemini-2.0-flash-lite,gemini-1.5-flash,gemini-1.5-flash-8b'),
  /**
   * Total in-process attempts per job attempt. Hard-capped at 4 so the ladder
   * cannot outlive BullMQ's own retry budget.
   */
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(4),
  /** Backoff before the first retry, in ms. Doubles up to GEMINI_RETRY_MAX_DELAY_MS. */
  GEMINI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  GEMINI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(10_000),
  /**
   * Retries on one model before rotating. 1 is the default because
   * GEMINI_MAX_ATTEMPTS is capped at 4 and the ladder has 4 entries: any higher
   * value stops the rotation before it reaches the last model. Raise it only
   * alongside a longer GEMINI_MODELS list.
   */
  GEMINI_ATTEMPTS_PER_MODEL: z.coerce.number().int().min(1).max(4).default(1),

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

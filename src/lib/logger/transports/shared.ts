import { safeError } from '../redaction.js';

/**
 * Credentials must never reach Loki or stdout.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.token',
];

export const REDACT_CENSOR = '[redacted]';

/**
 * Transport-owned serializers keep the same safe shape across entry points.
 */
export const SERIALIZERS = {
  err: (error: unknown) => error instanceof Error ? safeError(error) : error,
  req: (req: { method?: string; url?: string } | undefined) =>
    req ? { method: req.method, url: req.url?.split(/[?#]/, 1)[0] } : undefined,
  res: (res: { statusCode?: number } | undefined) =>
    res ? { statusCode: res.statusCode } : undefined,
};

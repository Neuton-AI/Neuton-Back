import { stdSerializers } from 'pino';

/**
 * Moved verbatim from the old inline Fastify logger config (issue #99 DOD):
 * credentials must never reach Loki or stdout.
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
 * Minimal serializers owned by the transports. Fastify passes its own
 * `req`/`res` serializers through `loggerInstance.child({}, opts)`, but the
 * facade ignores them — defining them here keeps every line shaped the same
 * regardless of which layer produced it, and avoids serializing raw headers
 * twice.
 */
export const SERIALIZERS = {
  err: stdSerializers.err,
  req: (req: { method?: string; url?: string } | undefined) =>
    req ? { method: req.method, url: req.url } : undefined,
  res: (res: { statusCode?: number } | undefined) =>
    res ? { statusCode: res.statusCode } : undefined,
};

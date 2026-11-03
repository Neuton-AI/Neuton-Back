const CENSOR = '[redacted]';
const sensitiveKey = /password|credential|token|secret|authorization|cookie|csrf|nonce|verifier|payload|^code$|^body$|^rawbody$|^query$|^params$|^parameters$/i;

export function redactLogText(value: string): string {
  if (/\b(?:password|secret|token|code|csrf|verifier|authorization)\s*[=:]/i.test(value)) return CENSOR;
  if (/^\$argon2|^[A-Za-z0-9_-]{43}$/.test(value)) return CENSOR;
  return value.replace(/(?:https?:\/\/|postgres(?:ql)?:\/\/)[^\s"'<>]+/gi, address => {
    try {
      const url = new URL(address);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return CENSOR;
      return url.origin + url.pathname;
    } catch {
      return CENSOR;
    }
  }).slice(0, 2000);
}

export function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: 'UnknownError' };
  return { type: error.constructor.name,
    stackFrames: error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 20).map(redactLogText) };
}

function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return safeError(value);
  if (Buffer.isBuffer(value)) return CENSOR;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? CENSOR : value.toISOString();
  if (typeof value === 'string') return redactLogText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6 || seen.has(value)) return CENSOR;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => safeValue(item, depth + 1, seen));
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    if (sensitiveKey.test(key)) {
      safe[key] = CENSOR;
    } else if (key === 'req' && entry && typeof entry === 'object') {
      const request = entry as { method?: unknown; url?: unknown };
      safe[key] = { method: request.method,
        url: typeof request.url === 'string' ? redactLogText(request.url.split(/[?#]/, 1)[0] ?? '') : undefined };
    } else if (key === 'err') {
      safe[key] = safeError(entry);
    } else {
      safe[key] = safeValue(entry, depth + 1, seen);
    }
  }
  return safe;
}

export function redactLogMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return safeValue(metadata, 0, new WeakSet()) as Record<string, unknown>;
}

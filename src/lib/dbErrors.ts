/**
 * Transient database failures (issue N-110).
 *
 * Supabase pauses an idle project; the first query after that — and the
 * reconnect window that follows — fails at the socket, or is refused by the
 * server while it is still resuming. Those are not application faults, so the
 * API answers 503 + `Retry-After` instead of a generic 500 that tells a client
 * nothing and hides a condition that clears on its own.
 *
 * Detection is deliberately narrow: a wrong "transient" verdict would paper over
 * a real 500, so it keys off the codes postgres.js / libpq actually emit for a
 * connection that is down or a server that is not ready yet — never off the
 * error message of an unrelated failure.
 */

/** Node/libuv socket codes raised before or during a failed connect. */
const SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** postgres.js connection-layer codes (`Errors.connection` in the driver). */
const POSTGRES_CONNECTION_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECTION_ERROR',
]);

/** SQLSTATE codes that mean "the server is not usable right now". */
const TRANSIENT_SQLSTATE_CODES = new Set([
  // Class 08 — Connection Exception.
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  // Server shutting down / still starting up.
  '57P01',
  '57P02',
  '57P03',
  // Out of connection slots / configuration limit reached.
  '53300',
  '53400',
  // Retryable transaction aborts.
  '40001',
  '40P01',
]);

/** Last resort for the few paths that only expose a message, never a code. */
const TRANSIENT_MESSAGE =
  /database system is (starting up|shutting down)|connection (refused|terminated|closed)|connect (e| )?timed\s?out|(econnrefused|econnreset|etimedout|ehostunreach|enetunreach|enotfound|econnaborted)|timeout exceeded when trying to connect|could not connect|too many clients/i;

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * Walks the `cause` chain because drizzle wraps driver errors: the postgres.js
 * error carrying the socket/SQLSTATE code is often one or two `cause` links
 * below the error the route actually throws.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    const code = codeOf(candidate);
    if (code) {
      const upper = code.toUpperCase();
      if (
        SOCKET_ERROR_CODES.has(upper) ||
        POSTGRES_CONNECTION_CODES.has(upper) ||
        TRANSIENT_SQLSTATE_CODES.has(upper)
      ) {
        return true;
      }
    }

    const message = messageOf(candidate);
    if (message && TRANSIENT_MESSAGE.test(message)) return true;

    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

/** Seconds advertised in `Retry-After` for a transient database outage. */
export const RETRY_AFTER_SECONDS = 5;

/** Machine-readable code for the 503 envelope. */
export const SERVICE_UNAVAILABLE_CODE = 'SERVICE_UNAVAILABLE';

/** Copy safe to show a client; it neither leaks nor blames the caller. */
export const SERVICE_UNAVAILABLE_MESSAGE =
  'Service temporarily unavailable, please retry shortly';

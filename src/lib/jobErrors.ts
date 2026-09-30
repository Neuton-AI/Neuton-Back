/**
 * Classifies job failures so permanent errors stop burning retries and
 * surface a useful message instead.
 */

/** Gemini/Google API errors carry the HTTP status as `status`. */
function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) return status;

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/"code"\s*:\s*(\d{3})/);
  if (match) return Number(match[1]);
  return null;
}

/**
 * Retrying these cannot help: the request is malformed, the key is
 * unauthorized, or the account cannot pay. Everything else (timeouts, 429s,
 * 5xx, transient R2/Redis errors) is worth another attempt.
 */
export function isPermanentError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status === null) return false;
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 413 || status === 422;
}

/**
 * A message safe to show a shop owner: the raw upstream payload often embeds
 * project, billing, or account identifiers.
 */
export function publicFailureMessage(error: unknown): string {
  const status = httpStatus(error);
  const raw = error instanceof Error ? error.message : String(error);

  if (status === 402) {
    return 'The AI vision service has no prepaid credit left. Add credit in AI Studio, then reprocess.';
  }
  if (status === 401 || status === 403) {
    return 'The AI vision service rejected its credentials. Check GEMINI_API_KEY.';
  }
  if (status === 429) {
    return 'The AI vision service is rate limiting requests. Retry in a minute.';
  }
  if (status === 413) {
    return 'The uploaded document is too large for the vision service.';
  }
  if (raw.includes('NoSuchKey')) return 'The uploaded document is no longer in storage.';
  if (raw.includes('exceeds MAX_UPLOAD_BYTES')) return 'The uploaded document is larger than the configured limit.';

  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
}

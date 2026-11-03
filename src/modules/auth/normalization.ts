import { domainToASCII } from 'node:url';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { badRequest } from '../../lib/errors.js';

/** In Unicode mode a valid surrogate pair matches its code point, not this range. */
export function isValidUnicode(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

export function normalizeEmail(value: string): { display: string; normalized: string } {
  const invalid = () => badRequest('Enter a valid email address');
  if (value.length > 640 || !isValidUnicode(value) || /[\p{Cc}\p{Cf}]/u.test(value)) throw invalid();
  const display = value.trim();
  const parts = display.split('@');
  const local = parts[0];
  const domain = parts[1];
  if (parts.length !== 2 || !local || !domain || display.length > 320 ||
    /[\s<>(),;:"\\\[\]]/u.test(local) || local.startsWith('.') || local.endsWith('.') ||
    local.includes('..') || /[\s/@:#?%\\]/u.test(domain)) {
    throw invalid();
  }
  const asciiDomain = domainToASCII(domain).toLowerCase();
  const labels = asciiDomain.split('.');
  if (labels.length < 2 || !labels.every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) {
    throw invalid();
  }
  const normalizedLocal = local.toLowerCase();
  const normalized = `${normalizedLocal}@${asciiDomain}`;
  if (Buffer.byteLength(local) > 64 || Buffer.byteLength(normalizedLocal) > 64 ||
    Buffer.byteLength(normalized) > 254) {
    throw invalid();
  }
  return { display, normalized };
}

export function validatePassword(value: string): string {
  const { minCodePoints, maxCodePoints } = AUTH_POLICY.password;
  if (value.length > maxCodePoints * 2 || !isValidUnicode(value)) {
    throw badRequest('Password must contain 15–128 valid Unicode code points');
  }
  const length = Array.from(value).length;
  if (length < minCodePoints || length > maxCodePoints) {
    throw badRequest('Password must contain 15–128 valid Unicode code points');
  }
  return value;
}

export function isBearerSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}

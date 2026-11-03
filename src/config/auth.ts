import { createHash } from 'node:crypto';
import { z } from 'zod';
import { databaseUrl, invalidConfig, readProcessDatabase, requiredSetting } from './database.js';
import type { DatabaseProcess, EnvironmentSource } from './database.js';
export { AUTH_POLICY } from './auth-policy.js';

function secretBytes(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) invalidConfig(field);
  return decoded;
}

function encryption(source: EnvironmentSource) {
  const activeKeyId = requiredSetting(source, 'AUTH_ENCRYPTION_ACTIVE_KEY_ID');
  let input: unknown;
  try {
    input = JSON.parse(requiredSetting(source, 'AUTH_ENCRYPTION_KEYS'));
  } catch {
    invalidConfig('AUTH_ENCRYPTION_KEYS');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidConfig('AUTH_ENCRYPTION_KEYS');
  const keys = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || typeof value !== 'string') {
      invalidConfig('AUTH_ENCRYPTION_KEYS');
    }
    keys.set(id, secretBytes(value, 'AUTH_ENCRYPTION_KEYS'));
  }
  if (!keys.has(activeKeyId) || keys.size > 8) invalidConfig('AUTH_ENCRYPTION_ACTIVE_KEY_ID');
  const rateLimitSecret = secretBytes(requiredSetting(source, 'AUTH_RATE_LIMIT_SECRET'), 'AUTH_RATE_LIMIT_SECRET');
  for (const key of keys.values()) {
    if (key.equals(rateLimitSecret)) invalidConfig('AUTH_RATE_LIMIT_SECRET');
  }
  return { activeKeyId, keys, rateLimitSecret };
}

function applicationOrigin(source: EnvironmentSource) {
  const mode = source.NODE_ENV ?? 'development';
  if (!['development', 'production', 'test'].includes(mode)) invalidConfig('NODE_ENV');
  const origin = requiredSetting(source, 'APP_ORIGIN');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    invalidConfig('APP_ORIGIN');
  }
  const localHttp = parsed.protocol === 'http:' && parsed.hostname === 'localhost' && mode !== 'production';
  if (origin !== parsed.origin || parsed.username || parsed.password ||
    (parsed.protocol !== 'https:' && !localHttp)) invalidConfig('APP_ORIGIN');
  const hash = createHash('sha256').update(`${mode}:${origin}`).digest('hex').slice(0, 24);
  const environment = `${mode}:${hash}`;
  return { origin, origins: [origin], environment, redisNamespace: `neuton:auth:${environment}`, localHttp };
}

function smtp(source: EnvironmentSource) {
  const host = requiredSetting(source, 'SMTP_HOST');
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.length > 253) invalidConfig('SMTP_HOST');
  const port = Number(requiredSetting(source, 'SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalidConfig('SMTP_PORT');
  const secureSetting = requiredSetting(source, 'SMTP_SECURE');
  if (!['true', 'false'].includes(secureSetting)) invalidConfig('SMTP_SECURE');
  const secure = secureSetting === 'true';
  if ((port === 465 && !secure) || (secure && port !== 465)) invalidConfig('SMTP_SECURE');
  const from = requiredSetting(source, 'MAIL_FROM');
  if (/[\r\n]/.test(from) || from.length > 500) invalidConfig('MAIL_FROM');
  let address = from;
  if (from.includes('<') || from.includes('>')) {
    const match = /^[^<>]+ <([^<>]+)>$/.exec(from);
    if (!match?.[1]) invalidConfig('MAIL_FROM');
    address = match[1];
  }
  if (!z.string().email().safeParse(address).success) {
    invalidConfig('MAIL_FROM');
  }
  return { host, port, secure, requireTLS: !secure, from,
    user: requiredSetting(source, 'SMTP_USER'), password: requiredSetting(source, 'SMTP_PASSWORD') };
}

function readApiConfig(source: EnvironmentSource) {
  const application = applicationOrigin(source);
  const redirectUri = requiredSetting(source, 'GOOGLE_REDIRECT_URI');
  if (redirectUri !== `${application.origin}/api/v1/auth/google/callback`) invalidConfig('GOOGLE_REDIRECT_URI');
  const listenUrl = databaseUrl(source, 'DATABASE_LISTEN_URL', 'neuton_app');
  if (new URL(listenUrl).hostname.includes('-pooler.')) invalidConfig('DATABASE_LISTEN_URL');
  return { process: 'api' as const, ...application,
    databases: { app: databaseUrl(source, 'DATABASE_URL', 'neuton_app'),
      auth: databaseUrl(source, 'AUTH_DATABASE_URL', 'neuton_auth'),
      cleanup: databaseUrl(source, 'CLEANUP_DATABASE_URL', 'neuton_cleanup'), listen: listenUrl },
    google: { clientId: requiredSetting(source, 'GOOGLE_CLIENT_ID'),
      clientSecret: requiredSetting(source, 'GOOGLE_CLIENT_SECRET'), redirectUri },
    smtp: smtp(source), encryption: encryption(source) };
}

export type ApiAuthConfig = ReturnType<typeof readApiConfig>;
export function readAuthConfig(process: 'api', source?: EnvironmentSource): ApiAuthConfig;
export function readAuthConfig<P extends Exclude<DatabaseProcess, 'api'>>(
  process: P, source?: EnvironmentSource,
): { process: P; databaseUrl: string };
export function readAuthConfig(process: DatabaseProcess, source: EnvironmentSource = globalThis.process.env) {
  if (process === 'api') return readApiConfig(source);
  return readProcessDatabase(process, source);
}

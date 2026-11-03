import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAuthConfig, AUTH_POLICY } from '../src/config/auth.js';

const key = Buffer.alloc(32, 17).toString('base64');
const rateSecret = Buffer.alloc(32, 43).toString('base64');
const url = (role: string) => `postgresql://${role}:synthetic@db.example/neuton?sslmode=require`;
const source = () => ({
  NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: url('neuton_app'), AUTH_DATABASE_URL: url('neuton_auth'),
  CLEANUP_DATABASE_URL: url('neuton_cleanup'), DATABASE_LISTEN_URL: url('neuton_app'),
  WORKER_DATABASE_URL: url('neuton_worker'), MIGRATION_DATABASE_URL: url('neondb_owner'),
  GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/google/callback',
  SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USER: 'synthetic-user', SMTP_PASSWORD: 'synthetic-password', MAIL_FROM: 'Neuton <noreply@example.com>',
  AUTH_ENCRYPTION_ACTIVE_KEY_ID: 'dev-v1', AUTH_ENCRYPTION_KEYS: JSON.stringify({ 'dev-v1': key }),
  AUTH_RATE_LIMIT_SECRET: rateSecret,
});

test('migration configuration requires only its owner connection', () => {
  const config = readAuthConfig('migration', { MIGRATION_DATABASE_URL: url('neondb_owner') });
  assert.deepEqual(config, { process: 'migration', databaseUrl: url('neondb_owner') });
  assert.equal(readAuthConfig('migration', { MIGRATION_DATABASE_URL: url('neuton_migrator') }).databaseUrl, url('neuton_migrator'));
});

test('worker and cleanup do not require Google, mail or encryption secrets', () => {
  assert.equal(readAuthConfig('worker', { WORKER_DATABASE_URL: url('neuton_worker') }).databaseUrl, url('neuton_worker'));
  assert.equal(readAuthConfig('cleanup', { CLEANUP_DATABASE_URL: url('neuton_cleanup') }).databaseUrl, url('neuton_cleanup'));
});

test('API configuration derives exact origin and environment identity', () => {
  const config = readAuthConfig('api', source());
  assert.equal(config.origin, 'http://localhost:5173');
  assert.equal(config.smtp.secure, false);
  assert.equal(config.smtp.requireTLS, true);
  assert.deepEqual(config.origins, ['http://localhost:5173']);
  assert.notEqual(config.environment, readAuthConfig('api', {
    ...source(), APP_ORIGIN: 'https://dev.example.com',
    GOOGLE_REDIRECT_URI: 'https://dev.example.com/api/v1/auth/google/callback',
  }).environment);
  assert.equal(AUTH_POLICY.password.memoryCostKiB, 65536);
});

test('API fails closed for unsafe origins, callbacks, roles and SMTP modes', () => {
  for (const patch of [
    { APP_ORIGIN: 'http://dev.example.com' }, { APP_ORIGIN: 'https://dev.example.com/path' },
    { NODE_ENV: 'production' }, { GOOGLE_REDIRECT_URI: 'https://attacker.example/callback' },
    { DATABASE_URL: url('neondb_owner') }, { DATABASE_URL: url('neuton_app').replace('require', 'disable') },
    { DATABASE_URL: url('neuton_app') + '&user=neondb_owner' },
    { DATABASE_URL: url('neuton_app') + '&options=-crole%3Dneuton_auth' },
    { DATABASE_URL: url('neuton_app') + '&channel_binding=require' },
    { SMTP_SECURE: 'truthy' }, { SMTP_PORT: '465', SMTP_SECURE: 'false' },
    { SMTP_PORT: '587', SMTP_SECURE: 'true' }, { MAIL_FROM: 'Neuton\r\nBcc: attacker@example.com' },
    { MAIL_FROM: 'noreply@example.com>' }, { MAIL_FROM: 'Neuton <noreply@example.com' },
  ]) {
    assert.throws(() => readAuthConfig('api', { ...source(), ...patch }));
  }
});

test('keyring requires canonical 32-byte keys and a distinct rate-limit secret', () => {
  for (const patch of [
    { AUTH_ENCRYPTION_ACTIVE_KEY_ID: 'missing' },
    { AUTH_ENCRYPTION_KEYS: '{bad json containing secret}' },
    { AUTH_ENCRYPTION_KEYS: JSON.stringify({ 'dev-v1': 'short' }) },
    { AUTH_RATE_LIMIT_SECRET: key }, { AUTH_RATE_LIMIT_SECRET: 'short' },
  ]) {
    assert.throws(() => readAuthConfig('api', { ...source(), ...patch }));
  }
});

test('configuration failures disclose field names without supplied values', () => {
  assert.throws(() => readAuthConfig('api', {
    ...source(), DATABASE_URL: 'postgresql://secret-owner:secret-password@secret-host/db',
  }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /DATABASE_URL/);
    assert.doesNotMatch(error.message, /secret-owner|secret-password|secret-host/);
    return true;
  });
});

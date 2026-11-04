import './support/testEnv.js';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { httpClient, testApplication } from './support/httpClient.js';
import { AppModule } from '../src/app.js';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { syntheticAuthConfig } from './support/authConfig.js';
import { createAuthServices } from '../src/modules/auth/auth-services.js';
import { AUTH_SERVICES } from '../src/modules/auth/auth.module.js';
import { AuthRateLimits } from '../src/modules/auth/rate-limit.service.js';

/**
 * Regression net for N-3.
 *
 * `setErrorHandler` used to sit *after* the five route plugins. Fastify
 * snapshots a route context's error handler when the route is added
 * (`lib/context.js`: `this.errorHandler = errorHandler || server[kErrorHandler]`),
 * so every production route kept Fastify's built-in handler. Every `AppError`
 * 4xx/409/413 and every `z.parse()` failure came back as a 500 carrying the raw
 * internal message, to unauthenticated callers.
 *
 * These assert the response *shape*, not just the status code, because a
 * status-code-only assertion is exactly what let the bug through: 500 was the
 * status in both the broken and the fixed world.
 *
 * They drive the real `buildApp`. A plugin registered after `buildApp` resolves
 * inherits the root handler regardless of where it was set, so a synthetic
 * probe would pass against the unfixed code and prove nothing.
 */

let app:ReturnType<typeof httpClient>;
let database: Awaited<ReturnType<typeof isolatedAuthDatabase>>['database'];

before(async () => {
  const isolated = await isolatedAuthDatabase();
  database = isolated.database;
  const config = syntheticAuthConfig();
  const limits = new AuthRateLimits({ async increment(_key, windowMs) { return { count: 1, retryMs: windowMs, windowId: 'synthetic' }; }, async release() {} },
    config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
  const services = createAuthServices(config, isolated.auth, isolated.orm, limits);
  app = httpClient(await testApplication(AppModule, [[AUTH_SERVICES, services]], { origins: [config.origin], authOrigin: config.origin }));
});

after(async () => {
  await app?.close();
  await database?.close();
});

/**
 * Fastify's default serializer emits `{statusCode, code, error, message}` with
 * `error` as a plain string. The app's envelope is `{error: {code, message}}`,
 * so the discriminator is the *type* of `error` plus the absence of
 * `statusCode` — not the mere presence of the key.
 */
function assertNotFastifyDefaultShape(response: { body: string; json: () => unknown }): void {
  const payload = response.json() as Record<string, unknown>;

  assert.ok(!('statusCode' in payload), `leaked default "statusCode" key: ${response.body}`);
  assert.notEqual(
    typeof payload.error,
    'string',
    `leaked default flat "error" string: ${response.body}`,
  );
}

interface AppEnvelope {
  code: unknown;
  message: unknown;
  details?: unknown;
}

function assertAppEnvelope(
  response: { statusCode: number; body: string; json: () => unknown },
  expectedStatus: number,
  expectedCode: string,
): AppEnvelope {
  assert.equal(
    response.statusCode,
    expectedStatus,
    `expected ${expectedStatus}, got ${response.statusCode}: ${response.body}`,
  );

  const payload = response.json() as Record<string, unknown>;

  assert.deepEqual(
    Object.keys(payload),
    ['error'],
    `error body must have exactly one top-level "error" key: ${response.body}`,
  );

  const envelope = payload.error as AppEnvelope;
  assert.equal(envelope.code, expectedCode, `unexpected code in: ${response.body}`);
  assert.equal(typeof envelope.message, 'string');
  assert.ok((envelope.message as string).length > 0, 'message must not be empty');

  return envelope;
}

test('401 from a route guard keeps its status and uses the app envelope', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/receipts' });

  assertAppEnvelope(response, 401, 'UNAUTHORIZED');
});

test('no guarded route returns Fastify default error shape', async () => {
  for (const url of [
    '/api/v1/session',
    '/api/v1/categories',
    '/api/v1/receipts',
    '/api/v1/orders',
    '/api/v1/analytics/dashboard',
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assertNotFastifyDefaultShape(response);
  }
});

test('every route plugin surfaces the custom error handler, not the default', async () => {
  for (const url of [
    '/api/v1/session',
    '/api/v1/categories',
    '/api/v1/receipts',
    '/api/v1/orders',
    '/api/v1/analytics/dashboard',
  ]) {
    const response = await app.inject({ method: 'GET', url });
    assertAppEnvelope(response, 401, 'UNAUTHORIZED');
  }
});

test('unknown route uses the app 404 envelope', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
  assertAppEnvelope(response, 404, 'NOT_FOUND');
});

test('a CORS rejection does not disclose internal text', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/receipts',
    headers: { origin: 'https://not-an-allowed-origin.example' },
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.ok(
    !response.body.includes('Origin not allowed by CORS'),
    `internal CORS text leaked: ${response.body}`,
  );

  const envelope = assertAppEnvelope(response, 500, 'INTERNAL_ERROR');
  assert.equal(envelope.message, 'Something went wrong');
});

test('successful routes are unaffected', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, service: 'neuton-api' });
});

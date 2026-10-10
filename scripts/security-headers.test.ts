import './support/testEnv.js';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

/**
 * N-115: `helmet({ contentSecurityPolicy: false })` shipped every Helmet
 * header *except* the one that actually stops script execution. The API
 * renders no HTML today, so the policy asserted here is the deny-all one:
 * any endpoint that later needs a resource has to widen it on purpose.
 *
 * The header is checked on a success, a 404 and a 500, because a middleware
 * that only decorates matched routes would satisfy a `/health`-only test.
 */

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  app.get('/__/boom/security-headers', async () => {
    throw new Error('boom');
  });
  await app.ready();
});

after(async () => {
  await app.close();
});

const EXPECTED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Helmet serializes directives in its own order, so compare as a set. */
function normalizeCsp(value: string): string[] {
  return value
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .sort();
}

function assertCspHeader(headers: Record<string, unknown>, context: string): void {
  const csp = headers['content-security-policy'];
  assert.equal(typeof csp, 'string', `missing content-security-policy header on ${context}`);
  for (const directive of normalizeCsp(EXPECTED_CSP)) {
    assert.ok(
      (csp as string).includes(directive),
      `expected "${directive}" in content-security-policy on ${context}, got: ${csp}`,
    );
  }
}

test('GET /health carries the deny-all CSP and still answers JSON', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200, response.body);
  assertCspHeader(response.headers, 'GET /health');
  assert.deepEqual(response.json(), { ok: true, service: 'neuton-api' });
  assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('GET /health exposes exactly the policy the ticket specifies', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.deepEqual(
    normalizeCsp(String(response.headers['content-security-policy'])),
    normalizeCsp(EXPECTED_CSP),
  );
});

test('a 404 carries the CSP header', async () => {
  const response = await app.inject({ method: 'GET', url: '/no-such-route' });

  assert.equal(response.statusCode, 404, response.body);
  assertCspHeader(response.headers, '404');
});

test('a 500 carries the CSP header', async () => {
  const response = await app.inject({ method: 'GET', url: '/__/boom/security-headers' });

  assert.equal(response.statusCode, 500, response.body);
  assertCspHeader(response.headers, '500');
});

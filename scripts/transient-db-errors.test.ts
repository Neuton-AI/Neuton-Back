import './support/testEnv.js';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
  isTransientDatabaseError,
  RETRY_AFTER_SECONDS,
  SERVICE_UNAVAILABLE_CODE,
  SERVICE_UNAVAILABLE_MESSAGE,
} from '../src/lib/dbErrors.js';
import { registerErrorHandler } from '../src/lib/errorHandler.js';

/**
 * N-110: transient DB failures (Supabase cold-start, dropped connection, server
 * starting up) must answer 503 + `Retry-After` with a `traceId`, not a generic
 * 500. The detector runs over real driver error shapes, the HTTP behaviour is
 * asserted through the real `buildApp`, and the log capture is verified against
 * the actual `registerErrorHandler` with a recording logger.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('classifies socket connect codes as transient', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE']) {
    assert.equal(isTransientDatabaseError({ code }), true, `expected ${code} to be transient`);
  }
});

test('classifies postgres.js connection codes as transient', () => {
  for (const code of ['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED']) {
    assert.equal(isTransientDatabaseError({ code }), true, `expected ${code} to be transient`);
  }
});

test('classifies SQLSTATE server-not-ready codes as transient', () => {
  for (const code of ['57P03', '57P01', '57P02', '53300', '53400', '08006', '08003', '08P01']) {
    assert.equal(isTransientDatabaseError({ code }), true, `expected ${code} to be transient`);
  }
});

test('walks the cause chain like drizzle wrapping', () => {
  const wrapped = new Error('transaction failed', { cause: new Error('query failed', { cause: { code: 'ECONNREFUSED' } }) });
  assert.equal(isTransientDatabaseError(wrapped), true);
});

test('accepts the message-only shapes some paths expose', () => {
  assert.equal(isTransientDatabaseError(new Error('FATAL: the database system is starting up')), true);
  assert.equal(isTransientDatabaseError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransientDatabaseError('connect ETIMEDOUT 1.2.3.4:5432'), true);
});

test('rejects permanent and unrelated failures', () => {
  assert.equal(isTransientDatabaseError(new Error('boom')), false);
  assert.equal(isTransientDatabaseError(new Error('Recipe insert returned no row')), false);
  assert.equal(isTransientDatabaseError({ code: '23503' }), false, 'FK violation is not transient');
  assert.equal(isTransientDatabaseError({ code: 'P2025' }), false, 'prisma not-found is not transient');
  assert.equal(isTransientDatabaseError({ code: '22P02' }), false, 'invalid text representation is not transient');
  assert.equal(isTransientDatabaseError({ statusCode: 500, message: 'upstream' }), false);
  assert.equal(isTransientDatabaseError(null), false);
});

// ---------------------------------------------------------------------------
// HTTP behaviour through the real app
// ---------------------------------------------------------------------------

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  // A top-level route inherits the root error handler, so it exercises the
  // exact handler production routes use, without needing auth or a database.
  app.get('/__/boom/transient', async () => {
    throw Object.assign(new Error('write ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  });
  app.get('/__/boom/permanent', async () => {
    throw new Error('Recipe insert returned no row');
  });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('a transient DB failure answers 503 with Retry-After and a traceId', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/__/boom/transient',
    headers: { 'x-trace-id': 'n110-test-abc' },
  });

  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.headers['retry-after'], String(RETRY_AFTER_SECONDS));
  assert.equal(response.headers['x-trace-id'], 'n110-test-abc');

  const body = response.json() as {
    error: { code: string; message: string; traceId: string };
  };
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error.code, SERVICE_UNAVAILABLE_CODE);
  assert.equal(body.error.message, SERVICE_UNAVAILABLE_MESSAGE);
  assert.equal(body.error.traceId, 'n110-test-abc', 'x-trace-id must be echoed for correlation');
});

test('a permanent unhandled error still answers 500, but carries a traceId and no Retry-After', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/__/boom/permanent',
    headers: { 'x-trace-id': 'n110-permanent-123' },
  });

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.headers['retry-after'], undefined, 'no Retry-After on a permanent 500');

  const body = response.json() as { error: { code: string; traceId: string } };
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.traceId, 'n110-permanent-123');
});

test('auth 4xx envelopes carry the traceId too', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/analytics/dashboard',
    headers: { 'x-trace-id': 'n110-auth-456' },
  });

  assert.equal(response.statusCode, 401, response.body);
  const body = response.json() as { error: { code: string; traceId: string } };
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(body.error.traceId, 'n110-auth-456');
});

// ---------------------------------------------------------------------------
// Log capture (traceId + full stack)
// ---------------------------------------------------------------------------

interface RecordedLine {
  level: string;
  first: unknown;
  second: unknown;
}

function recordingLogger(lines: RecordedLine[]): FastifyBaseLogger {
  const record = (level: string) => (first?: unknown, second?: unknown) => {
    lines.push({ level, first, second });
  };
  const logger = {
    level: 'info',
    info: record('info'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    warn: record('warn'),
    trace: record('trace'),
    silent() {},
    child() {
      return logger;
    },
  };
  return logger as unknown as FastifyBaseLogger;
}

test('the handler logs err (with stack) and traceId for a transient failure', async () => {
  const lines: RecordedLine[] = [];
  const probe = Fastify({ loggerInstance: recordingLogger(lines) });

  probe.decorateRequest('traceId', '');
  probe.addHook('onRequest', async (request) => {
    request.traceId = 'n110-log-trace-999';
  });
  probe.get('/boom', async () => {
    throw Object.assign(new Error('write CONNECT_TIMEOUT 127.0.0.1:5432'), {
      code: 'CONNECT_TIMEOUT',
    });
  });

  registerErrorHandler(probe);
  await probe.ready();

  const response = await probe.inject({ method: 'GET', url: '/boom' });
  assert.equal(response.statusCode, 503, response.body);

  const errorLine = lines.find((line) => line.level === 'error');
  assert.ok(errorLine, 'expected an error log line');

  const meta = errorLine.first as { err?: Error; traceId?: string };
  assert.equal(errorLine.second, 'database temporarily unavailable');
  assert.equal(meta.traceId, 'n110-log-trace-999');
  assert.ok(meta.err instanceof Error);
  assert.ok(meta.err.stack, 'expected the full stack trace to be captured');
  await probe.close();
});
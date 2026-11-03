import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { SecurityEvents } from '../src/modules/auth/security-events.js';
import { invalidCredentials, invalidAction, mapAuthDependencyError } from '../src/modules/auth/auth-errors.js';
import { AppError } from '../src/lib/errors.js';
import { LoggerImpl } from '../src/lib/logger/index.js';
import { AuthRepository } from '../src/modules/auth/auth.repository.js';

test('security events persist only bounded allowlisted metadata and internal identifiers', async () => {
  const statements: unknown[] = [];
  const transaction = { async execute(query: unknown) { statements.push(query); } };
  const events = new SecurityEvents();
  await events.append(transaction, {
    event: 'login', result: 'denied', correlationId: 'synthetic-trace', metadata: { method: 'password', reason: 'invalid_credentials' },
  });
  assert.equal(statements.length, 1);
  for (const metadata of [{ password: 'private-password' }, { email: 'private@example.com' },
    { reason: 'https://example.com/#token=private-token' }, { actionId: 'not-an-internal-id' }]) {
    await assert.rejects(events.append(transaction, {
      event: 'login', result: 'failed', correlationId: 'synthetic-trace', metadata,
    }));
  }
  assert.equal(statements.length, 1);
});

test('auth errors retain public distinctions while dependency details remain private', async () => {
  assert.deepEqual([invalidCredentials().statusCode, invalidCredentials().code, invalidCredentials().message],
    [401, 'INVALID_CREDENTIALS', 'Invalid email or password']);
  assert.equal(invalidAction().statusCode, 400);
  const outage = new Error('private SQL and credentials', { cause: Object.assign(new Error('private host'), { code: 'ECONNREFUSED' }) });
  const mapped = mapAuthDependencyError(outage);
  assert.ok(mapped instanceof AppError);
  assert.equal(mapped.statusCode, 503);
  assert.equal(mapped.message.includes('private'), false);
  assert.equal('cause' in mapped, false);
  assert.equal((mapAuthDependencyError(Object.assign(new Error('private statement timeout'), { code: '57014' })) as AppError).statusCode, 503);
  const denied = new AppError(403, 'FORBIDDEN', 'Access denied');
  assert.equal(mapAuthDependencyError(denied), denied);
  const validation = new z.ZodError([]);
  assert.equal(mapAuthDependencyError(validation), validation);
  const unavailable = new AuthRepository({ async transaction() { throw outage; } });
  await assert.rejects(unavailable.withUser('00000000-0000-4000-8000-000000000001', async () => true), {
    statusCode: 503, code: 'AUTH_UNAVAILABLE',
  });
});

test('logging removes nested auth secrets, callback URLs and private error causes before transport', () => {
  const lines: unknown[] = [];
  const logger = new LoggerImpl({ write(_level, message, metadata) { lines.push({ message, metadata }); } }, {
    credentials: { GOOGLE_CLIENT_SECRET: 'private-google-secret' },
  }, 'debug');
  const privateError = Object.assign(new Error('private-SQL-password'), {
    query: 'private SQL', parameters: ['private-parameter'], cause: new Error('private-cause'),
  });
  logger.error(privateError, {
    userId: 'internal-user-id', traceId: 'internal-trace',
    nested: { deeper: [{ newPassword: 'private-password', csrfToken: 'private-csrf', code: 'private-code' }] },
    req: { method: 'GET', url: '/api/v1/auth/google/callback?code=private-code&state=private-state', body: 'private-body' },
    link: 'https://example.com/confirm-email#token=private-link-secret',
    headers: { authorization: 'Bearer private-bearer', cookie: 'private-cookie', 'x-csrf-token': 'private-header-csrf' },
  });
  const serialized = JSON.stringify(lines);
  assert.equal(serialized.includes('private-'), false);
  assert.ok(serialized.includes('internal-user-id'));
  assert.ok(serialized.includes('internal-trace'));
  assert.ok(serialized.includes('/api/v1/auth/google/callback'));
  assert.ok(serialized.includes('auth-security.test'));
});

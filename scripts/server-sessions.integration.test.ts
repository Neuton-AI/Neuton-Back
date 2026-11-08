import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { AppError } from '../src/lib/errors.js';
import { SessionService } from '../src/modules/identity/session.service.js';

const url = testDatabaseUrl;
const skip = skipWithoutDisposableDatabase;
const day = 86_400_000;

test('opaque sessions use the account version and both strict expiry boundaries', { skip }, async () => {
  const connection = postgres(url!);
  let now = new Date('2026-01-01T00:00:00Z');
  const sessions = new SessionService(drizzle(connection, { schema }), () => now);
  const id = randomUUID();
  const email = `${id}@example.test`;
  const account = { id, passwordHash: 'credential-snapshot', securityVersion: 0 };
  try {
    await connection`INSERT INTO users (id, email, password_hash) VALUES (${id}, ${email}, ${account.passwordHash})`;
    const issued = await sessions.issue(account, now);
    assert.ok(issued);
    assert.equal(Buffer.from(issued.secret, 'base64url').length, 32);
    assert.equal(await sessions.resolve(issued.session.id), null);
    assert.equal(issued.session.idleExpiresAt.getTime(), now.getTime() + 7 * day);
    assert.equal(issued.session.absoluteExpiresAt.getTime(), now.getTime() + 30 * day);
    const [stored] = await connection`SELECT secret_digest FROM user_sessions WHERE id = ${issued.session.id}`;
    assert.equal(stored?.secret_digest, createHash('sha256').update(issued.secret).digest('hex'));
    assert.equal('secretDigest' in issued.session, false);
    assert.equal((await sessions.resolve(issued.secret))?.email, email);

    now = issued.session.idleExpiresAt;
    assert.equal(await sessions.resolve(issued.secret), null);
    await connection`UPDATE user_sessions SET idle_expires_at = absolute_expires_at WHERE id = ${issued.session.id}`;
    now = new Date(issued.session.absoluteExpiresAt.getTime() - 1);
    assert.equal((await sessions.resolve(issued.secret))?.userId, id);
    now = issued.session.absoluteExpiresAt;
    assert.equal(await sessions.resolve(issued.secret), null);

    now = issued.session.createdAt;
    await connection`UPDATE user_sessions SET revoked_at = ${now.toISOString()} WHERE id = ${issued.session.id}`;
    assert.equal(await sessions.resolve(issued.secret), null);
    const other = await sessions.issue(account, now);
    assert.ok(other);
    now = new Date(other.session.lastActivityAt.getTime() + 299_999);
    assert.equal((await sessions.renew(other.session)).extended, false);
    now = new Date(now.getTime() + 1);
    assert.equal((await sessions.renew(other.session)).extended, true);
    const absolute = other.session.absoluteExpiresAt.toISOString();
    await connection`UPDATE user_sessions SET idle_expires_at = ${absolute} WHERE id = ${other.session.id}`;
    now = new Date(other.session.absoluteExpiresAt.getTime() - day);
    const capped = await sessions.renew(other.session);
    assert.equal(capped.session.idleExpiresAt.toISOString(), absolute);
    await connection`UPDATE users SET security_version = 1 WHERE id = ${id}`;
    assert.equal(await sessions.resolve(other.secret), null);
    assert.equal(await sessions.issue(account, now), null);
    assert.equal(await sessions.issue({ ...account, passwordHash: 'stale-hash', securityVersion: 1 }, now), null);
  } finally {
    await connection`DELETE FROM users WHERE id = ${id}`;
    await connection.end();
  }
});

test('cleanup removes expired contexts and old sessions in repeatable batches', { skip }, async () => {
  const connection = postgres(url!);
  const now = new Date('2026-01-01T00:00:00Z');
  const timestamp = now.toISOString();
  const sessions = new SessionService(drizzle(connection, { schema }), () => now);
  const userId = randomUUID();
  const prefix = userId.replaceAll('-', '');
  try {
    await connection`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${`${userId}@example.test`}, 'test')`;
    await connection`
      INSERT INTO pre_auth_contexts (secret_digest, expires_at)
      SELECT ${prefix} || lpad(n::text, 32, '0'),
        CASE WHEN n <= 101 THEN ${timestamp}::timestamptz ELSE ${timestamp}::timestamptz + interval '1 second' END
      FROM generate_series(1, 102) AS n`;
    await connection`
      INSERT INTO user_sessions (user_id, secret_digest, security_version, created_at,
        last_activity_at, idle_expires_at, absolute_expires_at, revoked_at)
      SELECT ${userId}, ${prefix} || lpad(n::text, 32, '0'), 0,
        ${timestamp}::timestamptz - interval '40 days', ${timestamp}::timestamptz - interval '35 days',
        ${timestamp}::timestamptz - interval '1 day', ${timestamp}::timestamptz - interval '1 day',
        CASE WHEN n <= 101 THEN ${timestamp}::timestamptz - interval '30 days' END
      FROM generate_series(1, 102) AS n`;
    assert.deepEqual(await sessions.cleanup(), { sessions: 100, preAuthContexts: 100 });
    assert.deepEqual(await sessions.cleanup(), { sessions: 1, preAuthContexts: 1 });
    assert.deepEqual(await sessions.cleanup(), { sessions: 0, preAuthContexts: 0 });
    const retained = await connection`SELECT id FROM user_sessions WHERE user_id = ${userId}`;
    assert.equal(retained.length, 1);
    const contexts = await connection`
      SELECT expires_at > ${timestamp}::timestamptz AS active
      FROM pre_auth_contexts WHERE secret_digest LIKE ${`${prefix}%`}`;
    assert.deepEqual(contexts.map(({ active }) => active), [true]);
  } finally {
    await connection`DELETE FROM pre_auth_contexts WHERE secret_digest LIKE ${`${prefix}%`}`;
    await connection`DELETE FROM users WHERE id = ${userId}`;
    await connection.end();
  }
});

test('session store errors surface as 503 without credentials or query details', async () => {
  const connection = postgres('postgres://unused@127.0.0.1:1/unused');
  await connection.end();
  const sessions = new SessionService(drizzle(connection, { schema }));
  await assert.rejects(sessions.resolve('a'.repeat(43)), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.details, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('version changes serialize issuance and renewal and roll back with password replacement', { skip }, async () => {
  const connection = postgres(url!);
  const competingConnection = postgres(url!);
  const sessions = new SessionService(drizzle(connection, { schema }));
  const competing = new SessionService(drizzle(competingConnection, { schema }));
  const id = randomUUID();
  const account = { id, passwordHash: 'old-password-hash', securityVersion: 0 };
  try {
    await connection`INSERT INTO users (id, email, password_hash) VALUES (${id}, ${id + '@example.test'}, ${account.passwordHash})`;
    const issued = await sessions.issue(account, new Date());
    assert.ok(issued);
    const { session } = issued;
    await assert.rejects(sessions.transaction(async (tx) => {
      const { now } = await sessions.lockCurrent(tx, session);
      const version = await sessions.advanceVersion(tx, session, now, 'password_change', 'replacement-hash');
      await sessions.insert(tx, { id, securityVersion: version }, now);
      throw new AppError(503, 'TEST_ABORT', 'Abort transaction');
    }), { code: 'TEST_ABORT' });
    const [unchanged] = await connection`SELECT password_hash, security_version FROM users WHERE id = ${id}`;
    assert.deepEqual(unchanged, { password_hash: account.passwordHash, security_version: 0 });
    assert.ok(await competing.resolve(issued.secret));

    let overlapping: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await sessions.transaction(async (tx) => {
      const { now } = await sessions.lockCurrent(tx, session);
      overlapping = Promise.allSettled([competing.issue(account, now), competing.renew(session)]);
      await sessions.advanceVersion(tx, session, now, 'sign_out_all');
    });
    const [login, renewal] = (await overlapping)!;
    assert.deepEqual(login, { status: 'fulfilled', value: null });
    assert.equal(renewal?.status, 'rejected');
    assert.ok(renewal.reason instanceof AppError);
    assert.equal(renewal.reason.statusCode, 401);
    assert.equal(await competing.resolve(issued.secret), null);
  } finally {
    await connection`DELETE FROM users WHERE id = ${id}`;
    await connection.end();
    await competingConnection.end();
  }
});

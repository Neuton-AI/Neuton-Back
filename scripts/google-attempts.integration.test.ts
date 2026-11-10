import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema/index.js';
import { AppError } from '../src/lib/errors.js';
import { GoogleAttemptStore } from '../src/modules/identity/google-attempts.js';
import { GOOGLE_ISSUER } from '../src/modules/identity/google-oidc.js';
import { SessionService } from '../src/modules/identity/session.service.js';

const skip = skipWithoutDisposableDatabase;
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const key = Buffer.alloc(32, 2);
const proof: schema.GoogleCompletionProof = {
  identity: { issuer: GOOGLE_ISSUER, subject: 'test-subject', emailVerified: true }, observedLink: null,
};

async function createBinding(sessions: SessionService) {
  const { secret } = await sessions.createContext();
  return { purpose: 'sign_in' as const, contextSecret: secret };
}

test('anonymous attempts are capped, bound to one browser and claimed once across stores', { skip }, async () => {
  const connection = postgres(testDatabaseUrl!);
  const secondConnection = postgres(testDatabaseUrl!);
  const sessions = new SessionService(drizzle(connection, { schema }));
  const first = new GoogleAttemptStore(sessions, key);
  const second = new GoogleAttemptStore(new SessionService(drizzle(secondConnection, { schema })), key);
  const binding = await createBinding(sessions);
  const other = await createBinding(sessions);
  try {
    const results = await Promise.allSettled([first, second, first, second, first].map((store) => store.start(binding)));
    const attempts = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
    assert.equal(attempts.length, 3);
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.code, 'GOOGLE_ATTEMPT_LIMIT');
    }
    assert.equal(new Set(attempts.map(({ state }) => state)).size, 3);
    assert.equal(new Set(attempts.map(({ nonce }) => nonce)).size, 3);
    assert.equal(new Set(attempts.map(({ verifier }) => verifier)).size, 3);

    const attempt = attempts[0]!;
    const stateDigest = digest(attempt.state);
    const [stored] = await connection`SELECT encrypted_verifier FROM google_attempts WHERE state_digest = ${stateDigest}`;
    assert.ok(stored?.encrypted_verifier);
    assert.ok(!stored.encrypted_verifier.includes(attempt.verifier));
    assert.equal(await first.claim(other, attempt.state), null);
    const wrongKey = new GoogleAttemptStore(sessions, Buffer.alloc(32, 3));
    await assert.rejects(wrongKey.claim(binding, attempt.state), { code: 'SERVICE_UNAVAILABLE' });
    const callbacks = await Promise.all([first.claim(binding, attempt.state), second.claim(binding, attempt.state)]);
    assert.equal(callbacks.filter(Boolean).length, 1);
    const claim = callbacks.find((value) => value !== null)!;
    assert.equal(claim.verifier, attempt.verifier);
    assert.equal(claim.nonce, attempt.nonce);
    assert.equal((await connection`SELECT encrypted_verifier FROM google_attempts WHERE state_digest = ${stateDigest}`)[0]?.encrypted_verifier, null);

    const completions = await Promise.all([first.finish(binding, claim, proof), second.finish(binding, claim, proof)]);
    assert.equal(completions.filter(Boolean).length, 1);
    const completion = completions.find((value) => value !== null)!;
    const [completionRow] = await connection`SELECT completion_digest FROM google_attempts WHERE state_digest = ${stateDigest}`;
    assert.equal(completionRow?.completion_digest, digest(completion));
    await assert.rejects(first.start(binding), { code: 'GOOGLE_ATTEMPT_LIMIT' });
    assert.equal(await first.consume(other, completion, async () => 'wrong browser'), null);
    await assert.rejects(first.consume(binding, completion, async () => {
      throw new AppError(503, 'TEST_FAILURE', 'Test transaction rollback');
    }), { code: 'TEST_FAILURE' });
    const consumed = await Promise.all([first, second].map((store) => store.consume(binding, completion, async (_tx, value) => value)));
    assert.deepEqual(consumed.filter(Boolean), [proof]);
    assert.equal(await second.claim(binding, attempt.state), null);
    const canceled = await second.claim(binding, attempts[1]!.state);
    assert.ok(canceled);
    assert.equal(await second.finish(binding, canceled, null), null);
    assert.ok(await first.start(binding));
    assert.ok(await first.start(binding));
  } finally {
    await connection`DELETE FROM pre_auth_contexts WHERE secret_digest IN (${digest(binding.contextSecret)}, ${digest(other.contextSecret)})`;
    await connection.end();
    await secondConnection.end();
  }
});

test('attempts and completions expire at the earliest deadline', { skip }, async () => {
  const connection = postgres(testDatabaseUrl!);
  let now = new Date();
  const clock = () => now;
  const advance = (ms: number) => { now = new Date(now.getTime() + ms); };
  const sessions = new SessionService(drizzle(connection, { schema }), clock);
  const store = new GoogleAttemptStore(sessions, key, clock);
  const binding = await createBinding(sessions);
  const shortBinding = await createBinding(sessions);
  const contextDigest = digest(shortBinding.contextSecret);
  try {
    const contextExpiry = new Date(now.getTime() + 40_000);
    await connection`UPDATE pre_auth_contexts SET expires_at = ${contextExpiry.toISOString()} WHERE secret_digest = ${contextDigest}`;
    const started = await store.start(shortBinding);
    assert.ok(started);
    advance(10_000);
    const shortClaim = await store.claim(shortBinding, started.state);
    assert.ok(shortClaim);
    const shortCompletion = await store.finish(shortBinding, shortClaim, proof);
    assert.ok(shortCompletion);
    const [stored] = await connection`SELECT expires_at = ${contextExpiry.toISOString()}::timestamptz AS capped
      FROM google_attempts WHERE state_digest = ${digest(started.state)}`;
    assert.equal(stored?.capped, true);
    advance(30_000);
    assert.equal(await store.consume(shortBinding, shortCompletion, async () => 'expired'), null);
    assert.equal(await store.start(shortBinding), null);

    const regular = await store.start(binding);
    const late = await store.start(binding);
    const pending = await store.start(binding);
    assert.ok(regular && late && pending);
    const claim = await store.claim(binding, regular.state);
    assert.ok(claim);
    const completion = await store.finish(binding, claim, proof);
    assert.ok(completion);
    advance(60_000);
    assert.equal(await store.consume(binding, completion, async () => 'expired'), null);
    advance(239_999);
    const lateClaim = await store.claim(binding, late.state);
    assert.ok(lateClaim);
    const lateCompletion = await store.finish(binding, lateClaim, proof);
    assert.ok(lateCompletion);
    advance(1);
    assert.equal(await store.consume(binding, lateCompletion, async () => 'expired'), null);
    assert.equal(await store.claim(binding, pending.state), null);
  } finally {
    await connection`DELETE FROM pre_auth_contexts WHERE secret_digest IN (${digest(binding.contextSecret)}, ${contextDigest})`;
    await connection.end();
  }
});

test('link attempts require the exact live session and its original link revision', { skip }, async () => {
  const connection = postgres(testDatabaseUrl!);
  const sessions = new SessionService(drizzle(connection, { schema }));
  const store = new GoogleAttemptStore(sessions, key);
  const id = randomUUID();
  const account = { id, passwordHash: 'test-hash', securityVersion: 0 };
  try {
    await connection`INSERT INTO users (id, email, password_hash) VALUES (${id}, ${`${id}@example.test`}, ${account.passwordHash})`;
    const initiating = await sessions.issue(account, new Date());
    const other = await sessions.issue(account, new Date());
    assert.ok(initiating && other);
    const binding = { purpose: 'link' as const, session: initiating.session };
    const otherBinding = { ...binding, session: other.session };
    const attempt = await store.start(binding);
    assert.ok(attempt);
    assert.equal(await store.claim(otherBinding, attempt.state), null);
    const claim = await store.claim(binding, attempt.state);
    assert.ok(claim);
    const completion = await store.finish(binding, claim, proof);
    assert.ok(completion);
    assert.equal(await store.consume(otherBinding, completion, async () => 'wrong session'), null);
    await connection`UPDATE users SET google_link_revision = 1 WHERE id = ${id}`;
    assert.equal(await store.consume(binding, completion, async () => 'stale link'), null);
    const replacement = await store.start(binding);
    const pending = await store.start(binding);
    assert.ok(replacement && pending);
    const replacementClaim = await store.claim(binding, replacement.state);
    const pendingClaim = await store.claim(binding, pending.state);
    assert.ok(replacementClaim && pendingClaim);
    const replacementCompletion = await store.finish(binding, replacementClaim, proof);
    assert.ok(replacementCompletion);
    await sessions.revoke(other.session, initiating.session.id);
    await assert.rejects(store.finish(binding, pendingClaim, proof), { statusCode: 401 });
    await assert.rejects(store.consume(binding, replacementCompletion, async () => 'revoked'), { statusCode: 401 });
  } finally {
    await connection`DELETE FROM users WHERE id = ${id}`;
    await connection.end();
  }
});

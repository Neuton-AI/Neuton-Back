import assert from 'node:assert/strict';
import test from 'node:test';
import { isPermanentError, publicFailureMessage } from '../src/lib/jobErrors.js';

test('Gemini 402 is permanent', () => {
  const error = Object.assign(new Error('depleted'), { status: 402 });
  assert.equal(isPermanentError(error), true);
});

test('402 embedded in the payload is recognised even without a status field', () => {
  const error = new Error('{"error":{"code":402,"message":"depleted"},"status":"RESOURCE_EXHAUSTED"}');
  assert.equal(isPermanentError(error), true);
});

test('transient errors are retried', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isPermanentError(Object.assign(new Error('x'), { status })), false, `status ${status}`);
  }
  assert.equal(isPermanentError(new Error('ECONNRESET')), false);
  assert.equal(isPermanentError(new Error('socket hang up')), false);
});

test('401/403 are permanent', () => {
  assert.equal(isPermanentError(Object.assign(new Error('x'), { status: 401 })), true);
  assert.equal(isPermanentError(Object.assign(new Error('x'), { status: 403 })), true);
});

test('billing message is actionable and leaks no project identifiers', () => {
  const error = Object.assign(new Error('Your prepayment credits are depleted.'), { status: 402 });
  const message = publicFailureMessage(error);
  assert.match(message, /no prepaid credit/i);
  assert.match(message, /reprocess/i);
  assert.doesNotMatch(message, /projects|depleted|prepay/i);
});

test('unknown errors fall back to the original message, truncated', () => {
  assert.equal(publicFailureMessage(new Error('R2 object missing')), 'R2 object missing');

  const long = 'x'.repeat(900);
  const truncated = publicFailureMessage(new Error(long));
  assert.equal(truncated.length, 503);
  assert.ok(truncated.endsWith('...'));
});

test('recognises missing R2 object', () => {
  assert.equal(publicFailureMessage(new Error('NoSuchKey: nope')), 'The uploaded document is no longer in storage.');
});
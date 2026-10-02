import assert from 'node:assert/strict';
import test from 'node:test';
import { isPermanentError, isUnknownModelError, publicFailureMessage } from '../src/lib/jobErrors.js';

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

test('a retired model rotates instead of ending the ladder', () => {
  // Google answers a retired model with 400 or 404 "not found". Permanent for
  // that model, but the next one may be healthy, so the ladder must continue.
  const notFound400 = Object.assign(
    new Error('models/gemini-1.5-flash-8b is not found for API version v1beta, or is not supported for predict.'),
    { status: 400 },
  );
  assert.equal(isUnknownModelError(notFound400), true);
  assert.equal(isPermanentError(notFound400), false, 'must not abort the job');

  const gone404 = Object.assign(new Error('{"error":{"code":404,"message":"models/x is not found"}}'), {});
  assert.equal(isUnknownModelError(gone404), true);
  assert.equal(isPermanentError(gone404), false);
});

test('a real 400 is still permanent', () => {
  // A malformed request fails identically on every model: retrying is pointless.
  const malformed = Object.assign(new Error('Invalid JSON payload received'), { status: 400 });
  assert.equal(isUnknownModelError(malformed), false);
  assert.equal(isPermanentError(malformed), true);
});

test('exhausted capacity is actionable and leaks no upstream internals', () => {
  const raw = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
  );
  const message = publicFailureMessage(raw);
  assert.match(message, /busy right now/i);
  assert.match(message, /reprocess/i);
  assert.doesNotMatch(message, /UNAVAILABLE|projects|503|high demand/);
});
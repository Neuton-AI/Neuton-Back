import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_JOB_OPTIONS } from '../src/lib/queue.js';

/**
 * BullMQ's built-in `exponential` strategy is `delay * 2 ** (attemptsMade - 1)`
 * with no jitter configured here, so the whole retry schedule is derived from
 * `attempts` + `delay`. `attemptsMade` is 1 for the wait before attempt 2.
 * `scripts/test-upload-flow.ts` re-checks the same budget on a live enqueued job.
 */
function retryDelays(): number[] {
  const attempts = DEFAULT_JOB_OPTIONS.attempts ?? 1;
  const backoff = DEFAULT_JOB_OPTIONS.backoff as { type: string; delay: number };
  assert.equal(backoff.type, 'exponential', 'this schedule only models exponential backoff');
  return Array.from({ length: Math.max(attempts - 1, 0) }, (_, i) => Math.round(2 ** i * backoff.delay));
}

test('queue: a media job is attempted twice, not four times', () => {
  assert.equal(DEFAULT_JOB_OPTIONS.attempts, 2);
});

test('queue: the backoff base is 3s, down from 5s', () => {
  assert.deepEqual(DEFAULT_JOB_OPTIONS.backoff, { type: 'exponential', delay: 3_000 });
});

test('queue: the first retry lands at ~3s rather than ~5s', () => {
  const [firstRetry] = retryDelays();
  assert.equal(firstRetry, 3_000);
});

test('queue: the worst case is one 3s wait, not 5s/10s/20s', () => {
  assert.deepEqual(retryDelays(), [3_000]);
  const totalWait = retryDelays().reduce((sum, ms) => sum + ms, 0);
  assert.equal(totalWait, 3_000);
});

test('queue: neither half of the old 4-attempt / 5s schedule survives', () => {
  assert.notEqual(DEFAULT_JOB_OPTIONS.attempts, 4);
  assert.notEqual((DEFAULT_JOB_OPTIONS.backoff as { delay: number }).delay, 5_000);
});
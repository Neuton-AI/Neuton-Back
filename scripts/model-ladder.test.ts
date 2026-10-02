import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelLadder } from '../src/lib/modelLadder.js';

const MODELS = ['a', 'b', 'c', 'd'] as const;

/** Deterministic clock + RNG so policy assertions are not flaky. */
function makeLadder(randomValues: number[], start = 0, flagTtlMs = 1000) {
  let now = start;
  const calls = { random: 0 };
  const ladder = new ModelLadder({
    models: MODELS,
    flagTtlMs,
    random: () => {
      const v = randomValues[calls.random % randomValues.length] ?? 0;
      calls.random += 1;
      return v as number;
    },
    now: () => now,
  });
  return { ladder, advance: (ms: number) => (now += ms), randomCalls: () => calls.random };
}

test('picks only from the full pool when nothing is flagged', () => {
  const { ladder, randomCalls } = makeLadder([0]);
  assert.equal(ladder.pick(), 'a');
  assert.equal(randomCalls(), 1, 'a single pick must not burn extra rng values');
  assert.deepEqual(ladder.available(), ['a', 'b', 'c', 'd']);
});

test('a flagged model is never picked again while the flag holds', () => {
  const { ladder } = makeLadder([0]); // always index 0 => 'a'
  ladder.flag('a', 'rate-limited');
  assert.equal(ladder.isFlagged('a'), true);
  assert.deepEqual(ladder.available(), ['b', 'c', 'd']);
  assert.equal(ladder.pick(), 'b');
  assert.equal(ladder.pick(), 'b', 'b stays pickable until b is itself flagged');
});

test('flagged models return to the pool once the TTL expires', () => {
  const { ladder, advance } = makeLadder([0]);
  ladder.flag('a', 'unavailable');
  assert.equal(ladder.pick(), 'b');
  advance(1001);
  assert.equal(ladder.isFlagged('a'), false, 'expired flag must not persist');
  assert.equal(ladder.pick(), 'a');
});

test('re-flagging extends the window rather than shortening it', () => {
  const { ladder, advance } = makeLadder([0]);
  ladder.flag('a', 'unavailable');
  advance(900);
  ladder.flag('a', 'unavailable');
  advance(200); // past the first window, inside the second
  assert.equal(ladder.isFlagged('a'), true);
});

test('flags expire exactly at the TTL boundary', () => {
  const { ladder, advance } = makeLadder([0], 0, 1000);
  ladder.flag('a', 'rate-limited');
  advance(999);
  assert.equal(ladder.isFlagged('a'), true);
  advance(1);
  assert.equal(ladder.isFlagged('a'), false);
});

test('every model in the pool can be reached across picks', () => {
  // Spread of rng values: 0, .3, .6, .9 index into a shrinking pool.
  const { ladder } = makeLadder([0, 0.34, 0.67, 0.99]);
  const seen = new Set<string>();
  for (const m of ['a', 'b', 'c', 'd']) {
    const pick = ladder.pick();
    assert.ok(!seen.has(pick), `picked ${pick} twice, flags not respected`);
    seen.add(pick);
    ladder.flag(pick, 'unavailable');
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
});

test('flags expire back to the full pool when every model is sidelined', () => {
  // Pool wedged by every model being flagged must never wedge the worker.
  const { ladder } = makeLadder([0.5]);
  for (const m of MODELS) ladder.flag(m, 'unavailable');
  assert.deepEqual(ladder.available(), []);
  const pick = ladder.pick();
  assert.ok((MODELS as readonly string[]).includes(pick), 'must recover, not throw');
  assert.deepEqual(ladder.available().length, MODELS.length, 'wedged flags are cleared');
});

test('flagged reports reason and drops expired entries', () => {
  const { ladder, advance } = makeLadder([0]);
  ladder.flag('a', 'unknown-model');
  ladder.flag('b', 'unusable-response');
  assert.deepEqual(ladder.flagged(), { a: 'unknown-model', b: 'unusable-response' });
  advance(1001);
  assert.deepEqual(ladder.flagged(), {});
});

test('reset clears every flag immediately', () => {
  const { ladder } = makeLadder([0]);
  for (const m of MODELS) ladder.flag(m, 'unavailable');
  ladder.reset();
  assert.deepEqual(ladder.available(), ['a', 'b', 'c', 'd']);
});

test('rng values of 1 or above cannot index past the pool', () => {
  const { ladder } = makeLadder([1]); // Math.random() is <1, but a bad value must not throw
  const pick = ladder.pick();
  assert.ok((MODELS as readonly string[]).includes(pick));
});

test('rejects an empty pool and a non-positive TTL', () => {
  assert.throws(() => new ModelLadder({ models: [], flagTtlMs: 1000 }), /non-empty/);
  assert.throws(() => new ModelLadder({ models: MODELS, flagTtlMs: 0 }), /positive/);
});

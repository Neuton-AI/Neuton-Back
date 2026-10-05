import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walkModels } from '../src/lib/gemini.js';

const MODELS = ['a', 'b', 'c', 'd', 'e'] as const;

/** A Gemini/Google style error: an HTTP status on the thrown object. */
function apiError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** Records the models a walk asked for, in order. */
function recorder() {
  const asked: string[] = [];
  return {
    asked,
    /** Fails on every model named in `failing`, succeeds elsewhere. */
    call(failing: Record<string, () => Error>): (model: string) => Promise<string> {
      return async (model: string) => {
        asked.push(model);
        const makeError = failing[model];
        if (makeError) throw makeError();
        return `ok:${model}`;
      };
    },
  };
}

test('walks the models in declared order, first to last', async () => {
  const { asked, call } = recorder();

  const result = await walkModels(MODELS, call({}));

  assert.equal(result, 'ok:a', 'the first model succeeding returns immediately');
  assert.deepEqual(asked, ['a'], 'no model past the first success is called');
});

test('a failure on model 1 advances to model 2', async () => {
  const { asked, call } = recorder();

  const result = await walkModels(MODELS, call({ a: () => apiError('overloaded', 503) }));

  assert.equal(result, 'ok:b');
  assert.deepEqual(asked, ['a', 'b'], 'exactly one step forward, in order');
});

test('a success on the 5th model returns normally after four failures', async () => {
  const { asked, call } = recorder();
  const failing = Object.fromEntries(
    MODELS.slice(0, 4).map((m) => [m, () => apiError('overloaded', 503)]),
  );

  const result = await walkModels(MODELS, call(failing));

  assert.equal(result, 'ok:e');
  assert.deepEqual(asked, ['a', 'b', 'c', 'd', 'e']);
});

test('the walk is deterministic, not random: the same failures pick the same model', async () => {
  const failing = { a: () => apiError('overloaded', 503), b: () => apiError('overloaded', 503) };

  for (let run = 0; run < 5; run += 1) {
    const { asked, call } = recorder();
    assert.equal(await walkModels(MODELS, call(failing)), 'ok:c');
    assert.deepEqual(asked, ['a', 'b', 'c'], `run ${run} diverged`);
  }
});

test('a 429 on one model advances without sleeping on the next', async () => {
  const { asked, call } = recorder();
  const before = Date.now();

  const result = await walkModels(MODELS, call({ a: () => apiError('rate limited', 429) }));

  assert.equal(result, 'ok:b');
  assert.deepEqual(asked, ['a', 'b']);
  // The removed jittered backoff slept for up to its configured ceiling here.
  assert.ok(Date.now() - before < 500, 'no inter-model sleep');
});

test('a permanent error on model 1 does not advance', async () => {
  for (const status of [401, 402, 403, 413, 422]) {
    const { asked, call } = recorder();
    const permanent = apiError(`permanent ${status}`, status);

    await assert.rejects(
      () => walkModels(MODELS, call({ a: () => permanent })),
      (thrown: unknown) => thrown === permanent,
    );
    assert.deepEqual(asked, ['a'], `status ${status} must not burn the model list`);
  }
});

test('a permanent error on a later model stops the walk there', async () => {
  const { asked, call } = recorder();
  const permanent = apiError('no credit', 402);

  await assert.rejects(
    () =>
      walkModels(
        MODELS,
        call({
          a: () => apiError('overloaded', 503),
          b: () => permanent,
        }),
      ),
    (thrown: unknown) => thrown === permanent,
  );
  assert.deepEqual(asked, ['a', 'b'], 'models after the permanent failure are never called');
});

test('an unknown-model error advances like any other failure', async () => {
  const { asked, call } = recorder();

  const result = await walkModels(
    MODELS,
    call({
      a: () => apiError('models/a is not found for API version v1beta', 404),
      b: () => apiError('models/b is not supported', 400),
    }),
  );

  assert.equal(result, 'ok:c');
  assert.deepEqual(asked, ['a', 'b', 'c']);
});

test('a malformed-request 400 that is not an unknown model is still permanent', async () => {
  const { asked, call } = recorder();
  const permanent = apiError('Request contains an invalid argument', 400);

  await assert.rejects(
    () => walkModels(MODELS, call({ a: () => permanent })),
    (thrown: unknown) => thrown === permanent,
  );
  assert.deepEqual(asked, ['a'], 'only "not found"-shaped 400s rotate');
});

test('exhaustion throws the last error rather than returning null', async () => {
  const { asked, call } = recorder();
  const last = apiError('overloaded', 503);
  const failing = Object.fromEntries(
    MODELS.map((m, i) => [m, () => (i === MODELS.length - 1 ? last : apiError('overloaded', 503))]),
  );

  const outcome = await walkModels(MODELS, call(failing)).then(
    (value) => ({ resolved: value }),
    (error: unknown) => ({ rejected: error }),
  );

  assert.ok(!('resolved' in outcome), 'exhaustion must not resolve, not even with null');
  assert.equal(outcome.rejected, last, 'the last error is the one that escapes');
  assert.deepEqual(asked, [...MODELS], 'every model is tried exactly once');
});

test('exhaustion after a full list of unusable answers still throws', async () => {
  const { asked, call } = recorder();
  const unusable = Object.fromEntries(MODELS.map((m) => [m, () => new Error(`model ${m} returned no text`)]));

  await assert.rejects(() => walkModels(MODELS, call(unusable)), /model e returned no text/);
  assert.deepEqual(asked, [...MODELS]);
});

test('every model being unknown reports the misconfigured list, not the last error', async () => {
  const { asked, call } = recorder();
  const failing = Object.fromEntries(
    MODELS.map((m) => [m, () => apiError(`models/${m} is not found for API version v1beta`, 404)]),
  );

  await assert.rejects(
    () => walkModels(MODELS, call(failing)),
    (thrown: unknown) => {
      assert.match((thrown as Error).message, /No available vision model/);
      assert.match((thrown as Error).message, /Update GEMINI_MODELS/);
      // The names come from the list, not from the raw upstream payload.
      assert.deepEqual((thrown as Error).message.split(': ')[1]?.split('. Update')[0], 'a, b, c, d, e');
      return true;
    },
  );
  assert.deepEqual(asked, [...MODELS]);
});

test('one unknown model is enough to stop the misconfiguration message', async () => {
  const { asked, call } = recorder();
  const failing = Object.fromEntries(
    MODELS.map((m) => [
      m,
      () =>
        m === 'a'
          ? apiError('models/a is not found for API version v1beta', 404)
          : apiError('overloaded', 503),
    ]),
  );

  await assert.rejects(() => walkModels(MODELS, call(failing)), /overloaded/);
  assert.deepEqual(asked, [...MODELS]);
});

test('a transport failure with no status advances rather than aborting', async () => {
  const { asked, call } = recorder();

  const result = await walkModels(MODELS, call({ a: () => new Error('ECONNRESET') }));

  assert.equal(result, 'ok:b');
  assert.deepEqual(asked, ['a', 'b'], 'a network blip must not end the job');
});

test('an empty list cannot resolve and reports the misconfiguration', async () => {
  await assert.rejects(() => walkModels([], async () => 'never'), /No available vision model/);
});
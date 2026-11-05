import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthCleanupDispatcher } from '../src/modules/auth/auth-cleanup.js';

test('auth cleanup coalesces concurrent ticks, drains before stopping and retries failures without logging private errors', async () => {
  let calls = 0;
  let release = () => {};
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: unknown[] = [];
  const dispatcher = new AuthCleanupDispatcher({ async execute() { calls += 1; await blocked; } },
    { info: input => events.push(input), error: input => events.push(input) });
  const first = dispatcher.drain();
  assert.equal(dispatcher.drain(), first);
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  await dispatcher.drain();
  assert.equal(calls, 1);
  let unavailable = true;
  const retrying = new AuthCleanupDispatcher({ async execute() {
    if (unavailable) throw new Error('private database URI');
  } }, { info: input => events.push(input), error: input => events.push(input) });
  await assert.rejects(retrying.drain());
  unavailable = false;
  await retrying.drain();
  await retrying.stop();
  assert.equal(JSON.stringify(events).includes('private'), false);
  assert.ok(JSON.stringify(events).includes('auth_cleanup_failed'));
});

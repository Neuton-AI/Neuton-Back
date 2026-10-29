import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncEvents } from '../src/modules/sync/sync-events.js';

test('events reach only the selected shop and detached listeners stop receiving', () => {
  const events = new SyncEvents();
  const a: string[] = [],
    b: string[] = [];
  const stop = events.subscribe('a', (event) => a.push(event));
  events.subscribe('b', (event) => b.push(event));
  events.changed('a');
  assert.deepEqual(a, ['document-change']);
  assert.deepEqual(b, []);
  stop();
  events.changed('a');
  assert.equal(a.length, 1);
});

test('listener recovery wakes every attached shop to recover missed notifications', () => {
  const events = new SyncEvents();
  const received: string[] = [];
  events.subscribe('a', (event) => received.push(event));
  events.subscribe('b', (event) => received.push(event));
  events.recovered();
  assert.deepEqual(received, ['reconcile', 'reconcile']);
});

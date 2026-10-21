import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareDocuments,
  type DocumentMeta,
} from '../src/lib/documentSync.js';

test('metadata comparison partitions newer local, newer server and matching versions', () => {
  const meta = (id: string, updatedAt: number): DocumentMeta => ({
    kind: 'recipe',
    id,
    updatedAt,
  });
  const result = compareDocuments(
    [meta('local', 20), meta('server', 10), meta('equal', 10)],
    [meta('local', 10), meta('server', 20), meta('equal', 10), meta('new', 30)],
  );
  assert.deepEqual(
    result.toPush.map((row) => row.id),
    ['local'],
  );
  assert.deepEqual(
    result.toPull.map((row) => row.id),
    ['server', 'new'],
  );
});
test('document type participates in identity and deleted records cannot be resurrected', () => {
  const result = compareDocuments(
    [{ kind: 'recipe', id: 'same', updatedAt: 200 }],
    [
      { kind: 'recipe', id: 'same', updatedAt: 100, deleted: true },
      { kind: 'receipt', id: 'same', updatedAt: 50 },
    ],
  );
  assert.equal(result.toPush.length, 0);
  assert.equal(result.toPull.length, 2);
  assert.equal(result.toPull[0]?.deleted, true);
});
test('missing server records become local tombstones rather than duplicate creates', () => {
  assert.equal(
    compareDocuments([{ kind: 'order', id: 'missing', updatedAt: 100 }], [])
      .toPull[0]?.deleted,
    true,
  );
});

test('already applied tombstones for absent records do not trigger endless pulls', () => {
  assert.deepEqual(
    compareDocuments(
      [{ kind: 'order', id: 'missing', updatedAt: 100, deleted: true }],
      [],
    ),
    { toPush: [], toPull: [] },
  );
});

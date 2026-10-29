import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncService } from '../src/modules/sync/sync.service.js';
import type { SyncPersistence } from '../src/modules/sync/sync.persistence.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
const actor = { role: 'owner', shop: { id: 'fixture-shop' } } as ActorContext;
const service = (versions: number[]) => new SyncService({ version: async () => versions.shift() } as unknown as SyncPersistence);
test('a download racing a commit is retried and labelled with the stable server revision', async () => {
  let reads = 0;
  const result = await service([1, 2, 2, 2]).snapshot(actor, 'recipe', 'id', async () => ({ recipe: { name: `Read ${++reads}` } }));
  assert.deepEqual(result, { recipe: { name: 'Read 2' }, syncVersion: 2 });
});
test('a continuously changing document is retried later rather than persisted with a wrong version', async () => {
  await assert.rejects(() => service([1, 2, 3, 4, 5, 6]).snapshot(actor, 'recipe', 'id', async () => ({ recipe: {} })),
    { statusCode: 503, code: 'SYNC_SNAPSHOT_RETRY' });
});

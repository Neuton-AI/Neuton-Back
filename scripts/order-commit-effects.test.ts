import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { SyncService } from '../src/modules/sync/sync.service.js';
import type { SyncPersistence, SyncTransaction } from '../src/modules/sync/sync.persistence.js';
import { actorFor } from './support/nestOrdersApp.js';

for (const replay of [false, true]) {
  test(`rolled-back sync attempts discard their success effects, including replay=${replay}`, async () => {
    let attempts = 0;
    const emitted: number[] = [];
    const persistence = {
      async mutate(_actor: unknown, _input: unknown, operation: (tx: SyncTransaction) => Promise<unknown>) {
        attempts++;
        if (attempts === 1) {
          await operation({} as SyncTransaction);
          throw Object.assign(new Error('rollback'), { code: '40001' });
        }
        if (!replay) await operation({} as SyncTransaction);
        return { status: 201, body: { saved: true } };
      },
    } as SyncPersistence;
    const result = await new SyncService(persistence).mutate(actorFor(), {
      kind: 'order', documentId: null, method: 'POST', path: '/api/v1/orders', body: {},
      status: 201, mutationId: randomUUID(), version: 1,
    }, async (_tx, afterCommit) => {
      const thisAttempt = attempts;
      afterCommit?.(async () => { emitted.push(thisAttempt); });
      return { saved: true };
    });
    assert.equal(attempts, 2);
    assert.deepEqual(result, { status: 201, body: { saved: true } });
    assert.deepEqual(emitted, replay ? [] : [2]);
  });
}

import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database } from '../src/db/client.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { referenceVerifiedSession } from '../src/modules/identity/verified-session.js';
import { ShopOperation } from '../src/db/shop-operation.js';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const shopId = '33333333-3333-4333-8333-333333333333';
const actor = {
  user: { id: userId }, sessionId, session: referenceVerifiedSession(userId, sessionId),
  shop: { id: shopId }, role: 'owner'
} as ActorContext;

test('business boundary sets context before work and uses current membership', async () => {
  const calls: string[] = [];
  const transaction = { async execute() { calls.push('sql'); return [{ role: 'member' }]; } };
  const database = {
    async transaction(work: (tx: typeof transaction) => Promise<unknown>) {
    calls.push('begin'); const result = await work(transaction); calls.push('commit'); return result;
    }
  } as unknown as Database;
  const operation = new ShopOperation(database);
  assert.throws(() => operation.database, /Shop transaction required/);
  await operation.run(actor, async (scope, currentActor, afterCommit) => {
    assert.equal(scope.database, transaction);
    assert.equal(currentActor.role, 'member');
    calls.push('work');
    afterCommit?.(async () => { calls.push('effect'); });
  });
  assert.deepEqual(calls, ['begin', 'sql', 'sql', 'work', 'commit', 'effect']);
  calls.length = 0;
  await assert.rejects(operation.run(actor, async (_, __, afterCommit) => {
    afterCommit?.(async () => { calls.push('effect'); });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(calls.includes('effect'), false);
});

test('a bound operation refuses attribution or shop changes', async () => {
  const operation = new ShopOperation({
    scope: 'shop', database: {} as never,
    userId, sessionId, shopId, role: 'admin'
  });
  await assert.rejects(operation.run({ ...actor, user: { ...actor.user, id: shopId } }, async () => {}), { statusCode: 403 });
  await assert.rejects(operation.run({ ...actor, shop: { ...actor.shop, id: userId } }, async () => {}), { statusCode: 403 });
  await operation.run(actor, async (_, currentActor) => assert.equal(currentActor.role, 'admin'));
});

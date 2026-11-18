import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { retryTransaction } from '../src/lib/transactionRetry.js';
for (const code of ['40001', '40P01']) {
  test(`retries a confirmed ${code} rollback by rerunning the entire transaction`, async () => {
    let attempts = 0;
    const value = await retryTransaction(async () => {
      attempts++;
      if (attempts < 3) throw new Error('wrapped', { cause: Object.assign(new Error('rollback'), { code }) });
      return 'committed';
    });
    assert.equal(value, 'committed');
    assert.equal(attempts, 3);
  });
}
test('exhaustion is bounded and ambiguous connection failures are never retried', async () => {
  for (const code of ['40001', '08006', '23505']) {
    let attempts = 0;
    await assert.rejects(retryTransaction(async () => {
      attempts++;
      throw Object.assign(new Error('failed'), { code });
    }));
    assert.equal(attempts, code === '40001' ? 12 : 1);
  }
});

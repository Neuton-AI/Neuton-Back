import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type postgres from 'postgres';

export async function waitForBlockedTransactions(connection: postgres.Sql, blockingPid: number, count: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await connection<{ count: number }[]>`WITH RECURSIVE blocked(pid) AS (
      SELECT ${blockingPid}::integer UNION
      SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
    ) SELECT count(*)::integer - 1 AS count FROM blocked`;
    if (row && row.count >= count) return;
    await delay(20);
  }
  assert.fail('Requests did not queue on the account row');
}

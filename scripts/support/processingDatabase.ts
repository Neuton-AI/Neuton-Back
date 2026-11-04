import './testEnv.js';
import assert from 'node:assert/strict';
import { sql, type SQL } from 'drizzle-orm';
import { isolatedAuthDatabase } from './authDatabase.js';
import { AccountRepository } from '../../src/modules/auth/account.repository.js';
import { SessionRepository } from '../../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../../src/modules/shops/contracts.js';
import type { Database } from '../../src/db/client.js';
import type { ActorContext } from '../../src/modules/identity/contracts.js';
import { apiLogger } from '../../src/lib/logger/index.js';

export async function processingDatabase() {
  const fixture = await isolatedAuthDatabase();
  const { database, orm, auth } = fixture;
  let activeTransactions = 0;
  type Tx = Parameters<Parameters<typeof orm.transaction>[0]>[0];
  function asRole(role: 'neuton_app' | 'neuton_worker' | 'neuton_cleanup') {
    const client = { transaction<T>(work: (tx: Tx) => Promise<T>) {
      return orm.transaction(async tx => {
        await tx.execute(sql`set local role ${sql.identifier(role)}`);
        activeTransactions += 1;
        try { return await work(tx); } finally { activeTransactions -= 1; }
      });
    }, execute(statement: SQL) { return client.transaction(tx => tx.execute(statement)); } };
    return client as unknown as Database;
  }
  const application = asRole('neuton_app');
  const accounts = new AccountRepository(auth);
  const sessions = new SessionRepository(auth);
  const userId = await auth.transaction(async tx => {
    const account = await accounts.createPending(tx, { email: 'processing@example.com', fullName: 'Owner' });
    assert.ok(account); return account.user.id;
  });
  await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [userId]);
  const issued = await auth.withUser(userId, account => sessions.issue(account, { method: 'password' }, {}));
  assert.ok(issued);
  const resolved = await sessions.resolve(issued.secret);
  assert.ok(resolved);
  const identity = {
    session: resolved.reference, sessionId: resolved.id,
    user: { id: userId, email: resolved.email, fullName: 'Owner', avatarUrl: null },
    log: apiLogger, traceId: 'processing-fixture', requestId: 'processing-fixture',
  };
  const shop = await new ShopsPersistence(application).create(identity, createShopSchema.parse({ name: 'Processing Kitchen' }));
  const actor = { ...identity, shop, role: 'owner' } as ActorContext;
  return { ...fixture, application, worker: asRole('neuton_worker'), cleanup: asRole('neuton_cleanup'), actor,
    outsideSql() { assert.equal(activeTransactions, 0, 'external operation must run outside SQL'); } };
}

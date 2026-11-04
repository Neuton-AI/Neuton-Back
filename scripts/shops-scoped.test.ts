import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema, shopSettingsSchema } from '../src/modules/shops/contracts.js';
import type { Database } from '../src/db/client.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { apiLogger } from '../src/lib/logger/index.js';

test('onboarding and profile/settings operations use verified scopes and atomic audit writes', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const sessions = new SessionRepository(auth);
    const accountId = await auth.transaction(async transaction => {
      const account = await accounts.createPending(transaction, { email: 'owner@example.com', fullName: 'Original name' });
      assert.ok(account); return account.user.id;
    });
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [accountId]);
    const issued = await auth.withUser(accountId, account => sessions.issue(account, { method: 'password' }, {}));
    assert.ok(issued);
    const resolved = await sessions.resolve(issued.secret);
    assert.ok(resolved);
    type Transaction = Parameters<Parameters<typeof orm.transaction>[0]>[0];
    const application = { transaction<T>(work: (transaction: Transaction) => Promise<T>) {
      return orm.transaction(async transaction => { await transaction.execute(sql`set local role neuton_app`); return work(transaction); });
    } };
    // The production persistence uses only the shared Drizzle transaction API; this adapter exercises it on real PostgreSQL.
    const shops = new ShopsPersistence(application as unknown as Database);
    const actor = { user: { id: accountId, email: resolved.email, fullName: 'Original name', avatarUrl: null }, session: resolved.reference,
      sessionId: resolved.id, requestId: 'synthetic', traceId: 'synthetic', log: apiLogger };
    const created = await shops.create(actor, createShopSchema.parse({ name: 'Kitchen' }));
    assert.equal(created.targetProfitMargin, '35.00');
    const second = await shops.create(actor, createShopSchema.parse({ name: 'Kitchen' }));
    assert.notEqual(created.slug, second.slug);
    assert.equal((await database.query('select id from public.profiles')).rows.length, 1);
    assert.equal((await database.query('select id from public.audit_logs')).rows.length, 2);
    const updated = await shops.update({ ...actor, role: 'owner', shop: created } as ActorContext, shopSettingsSchema.parse({ name: 'Updated Kitchen' }));
    assert.equal(updated.name, 'Updated Kitchen');
    assert.equal((await database.query('select id from public.audit_logs')).rows.length, 3);
    const profile = await shops.updateProfile(actor, { fullName: 'Changed name' });
    assert.equal(profile.fullName, 'Changed name');
    const foreignId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await assert.rejects(shops.find({ ...actor, role: 'owner', shop: { ...created, id: foreignId } } as ActorContext), { statusCode: 403 });
    await auth.withUser(accountId, account => auth.invalidateSecurityState(account, 'logout_all'));
    await assert.rejects(shops.profile(actor), { statusCode: 401 });
  } finally { await database.close(); }
});

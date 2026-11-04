import './support/testEnv.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { isolatedAuthDatabase } from './support/authDatabase.js';
import { AccountRepository } from '../src/modules/auth/account.repository.js';
import { SessionRepository } from '../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../src/modules/shops/shops.persistence.js';
import { createShopSchema, shopSettingsSchema } from '../src/modules/shops/contracts.js';
import type { Database } from '../src/db/client.js';
import type { ActorContext } from '../src/modules/identity/contracts.js';
import { apiLogger } from '../src/lib/logger/index.js';

test('onboarding rolls shop/owner/audit back together and slug conflicts do not require cross-shop reads', async () => {
  const { database, orm, auth } = await isolatedAuthDatabase();
  try {
    const accounts = new AccountRepository(auth);
    const sessions = new SessionRepository(auth);
    const id = await auth.transaction(async transaction => {
      const account = await accounts.createPending(transaction, { email: 'synthetic@example.com', fullName: 'User' });
      assert.ok(account); return account.user.id;
    });
    await database.query("update auth_private.users set status='active',email_confirmed_at=now() where id=$1", [id]);
    const issued = await auth.withUser(id, account => sessions.issue(account, { method: 'password' }, {}));
    assert.ok(issued);
    const resolved = await sessions.resolve(issued.secret);
    assert.ok(resolved);
    type Transaction = Parameters<Parameters<typeof orm.transaction>[0]>[0];
    const application = { transaction<T>(work: (transaction: Transaction) => Promise<T>) {
      return orm.transaction(async transaction => { await transaction.execute(sql`set local role neuton_app`); return work(transaction); });
    } };
    const persistence = new ShopsPersistence(application as unknown as Database);
    const actor = { user: { id, email: resolved.email, fullName: 'User', avatarUrl: null }, session: resolved.reference,
      sessionId: resolved.id, requestId: 'synthetic', traceId: 'synthetic', log: apiLogger };
    const body = createShopSchema.parse({ name: 'Existing' });
    await database.exec("alter table public.shop_members add constraint synthetic_fail_owner check(role <> 'owner')");
    await assert.rejects(persistence.create(actor, body));
    for (const table of ['shops', 'shop_members', 'audit_logs']) {
      assert.equal((await database.query<{ count: number }>(`select count(*)::int as count from public.${table}`)).rows[0]?.count, 0);
    }
    assert.equal((await database.query('select id from public.profiles')).rows.length, 1);
    await database.exec('alter table public.shop_members drop constraint synthetic_fail_owner');
    const first = await persistence.create(actor, body);
    const second = await persistence.create(actor, body);
    assert.equal(first.slug, 'existing');
    assert.notEqual(first.slug, second.slug);
    const scoped = { ...actor, shop: first, role: 'owner' } as ActorContext;
    assert.equal((await persistence.update(scoped, shopSettingsSchema.parse({ slug: first.slug }))).slug, first.slug);
    await assert.rejects(persistence.update({ ...scoped, shop: second }, shopSettingsSchema.parse({ slug: first.slug })), { statusCode: 409 });
    const before = (await persistence.find(scoped)).name;
    await database.exec(`create function public.synthetic_fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit failure'; end $$;
      create trigger synthetic_fail_audit before insert on public.audit_logs for each row execute function public.synthetic_fail_audit()`);
    await assert.rejects(persistence.update(scoped, shopSettingsSchema.parse({ name: 'Must roll back' })));
    assert.equal((await persistence.find(scoped)).name, before);
  } finally { await database.close(); }
});

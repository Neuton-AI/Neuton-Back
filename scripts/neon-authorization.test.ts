import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { withShopTransaction, withUserTransaction } from '../src/db/tenant-context.js';
import { referenceVerifiedSession } from '../src/modules/identity/verified-session.js';
import * as schema from '../src/db/schema/index.js';
import { migrationChecksum, runMigrationBatch } from '../src/db/migration-ledger.js';
import type { MigrationDatabase } from '../src/db/migration-ledger.js';

test('fresh Neon schema enforces tenant, credential, worker and cleanup boundaries in PostgreSQL', async () => {
  const db = new PGlite();
  try {
    for (const role of ['neuton_app','neuton_auth','neuton_worker','neuton_cleanup','neuton_policy_reader','neuton_bootstrap','neuton_maintenance']) {
      await db.exec(`create role ${role} nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`);
    }
    const directory = new URL('../drizzle-neon/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    const accounts = Array.from({ length: 3 }, () => ({ user: randomUUID(), session: randomUUID() }));
    const [owner, other, member] = accounts;
    assert.ok(owner && other && member);
    for (const [index, account] of accounts.entries()) {
      await db.query(`insert into auth_private.users(id,email,normalized_email,status,email_confirmed_at)
        values ($1,$2,$2,'active',now())`, [account.user, `synthetic-${index}@example.test`]);
      await db.query('insert into public.profiles(id) values ($1)', [account.user]);
      await db.query(`insert into auth_private.sessions(id,user_id,token_digest,csrf_digest,security_version,authenticated_at,
        authentication_method,recent_authenticated_at,last_activity_at,idle_expires_at,absolute_expires_at)
        values ($1,$2,$3,$3,1,now(),'password',now(),now(),now()+interval '7 days',now()+interval '30 days')`,
      [account.session, account.user, String(index + 1).repeat(64)]);
    }
    async function asUser<T>(account: typeof owner, shop: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
      assert.ok(account);
      return db.transaction(async tx => {
        await tx.exec('set local role neuton_app');
        await tx.query(`select set_config('neuton.user_id',$1,true),set_config('neuton.session_id',$2,true),set_config('neuton.shop_id',$3,true)`,
          [account.user, account.session, shop]);
        return work(tx);
      });
    }
    const createShop = (account: typeof owner, slug: string) => asUser(account, '', async tx => {
      const result = await tx.query<{ id: string }>('select id from app_private.create_shop($1,$2)', [slug, slug]);
      return result.rows[0]!.id;
    });
    const shop = await createShop(owner, 'kitchen-a');
    const foreignShop = await createShop(other, 'kitchen-b');
    const secondShop = await createShop(owner, 'kitchen-c');
    const orm = drizzle(db, { schema });
    type AppTransaction = Parameters<Parameters<typeof orm.transaction>[0]>[0];
    const application = {
      transaction<R>(work: (transaction: AppTransaction) => Promise<R>): Promise<R> {
        return orm.transaction(async transaction => {
          await transaction.execute(sql`set local role neuton_app`);
          return work(transaction);
        });
      },
    };
    const reference = referenceVerifiedSession(owner.user, owner.session);
    await withShopTransaction(application, reference, shop, async scope => {
      assert.equal(scope.role, 'owner');
      assert.equal(scope.shopId, shop);
      assert.equal((await scope.database.select().from(schema.shops)).length, 2);
    });
    await withUserTransaction(application, reference, async scope => {
      assert.equal(scope.scope, 'user');
      assert.equal((await scope.database.select().from(schema.recipes)).length, 0);
    });
    await assert.rejects(withShopTransaction(application, reference, foreignShop, async () => {}), /Shop access/);
    const serialized = JSON.parse(JSON.stringify(reference));
    await assert.rejects(withUserTransaction(application, serialized, async () => {}), /Verified session/);
    const unavailable = { async transaction<R>(_work: (transaction: AppTransaction) => Promise<R>): Promise<R> {
      throw Object.assign(new Error('synthetic private connection failure'), { code: 'ECONNREFUSED' });
    } };
    await assert.rejects(withUserTransaction(unavailable, reference, async () => {}), error => {
      assert.ok(error instanceof Error && 'statusCode' in error);
      assert.equal(error.statusCode, 503);
      assert.doesNotMatch(error.message, /private connection/);
      return true;
    });
    await asUser(owner, '', tx => tx.query("select app_private.change_membership($1,$2,'member')", [shop, member.user]));
    await asUser(owner, shop, tx => tx.query("insert into public.recipes(shop_id,name) values ($1,'Flour recipe')", [shop]));
    assert.equal((await asUser(other, foreignShop, tx => tx.query('select * from public.recipes'))).rows.length, 0);
    assert.equal((await asUser(owner, '', tx => tx.query('select * from public.recipes'))).rows.length, 0);
    assert.equal((await asUser(owner, '', tx => tx.query('select * from public.shops'))).rows.length, 2);
    assert.equal((await asUser(owner, '', tx => tx.query('select * from public.profiles'))).rows.length, 1);
    await assert.rejects(asUser(owner, shop, tx => tx.query('update public.recipes set shop_id=$1', [secondShop])), /Immutable row identity/);
    await assert.rejects(asUser(member, shop, tx => tx.query("insert into public.recipes(shop_id,name) values ($1,'Forbidden')", [shop])), /row-level security/);
    await assert.rejects(asUser(owner, shop, tx => tx.query('select * from auth_private.sessions')), /permission denied/);
    // SET ROLE from PGlite's superuser session retains its session-user powers;
    // inspect the runtime role graph rather than treating that as a login.
    const membership = await db.query<{ allowed: boolean }>("select pg_has_role('neuton_app','neuton_policy_reader','MEMBER') as allowed");
    assert.equal(membership.rows[0]!.allowed, false);
    await assert.rejects(asUser(owner, shop, tx => tx.exec('delete from public.audit_logs')), /permission denied/);
    await assert.rejects(asUser(owner, '', tx => tx.query('select app_private.change_membership($1,$2,NULL)', [shop, owner.user])), /last owner/);
    await assert.rejects(asUser(member, '', tx => tx.query("select app_private.change_membership($1,$2,'owner')", [shop, member.user])), /forbidden/);
    const orderId = randomUUID();
    await asUser(owner, shop, tx => tx.query(`insert into public.orders(id,shop_id,user_id,order_number)
      values ($1,$2,$3,app_private.next_order_number())`, [orderId, shop, owner.user]));
    const edited = await asUser(member, shop, tx => tx.query('update public.orders set total_amount=100 where id=$1 returning id', [orderId]));
    assert.equal(edited.rows.length, 0);
    const verified = await asUser(member, shop, tx => tx.query<{ done: boolean }>('select app_private.mark_order_delivered($1) as done', [orderId]));
    assert.equal(verified.rows[0]!.done, true);
    await assert.rejects(asUser(owner, shop, async tx => {
      await tx.query('select app_private.next_order_number()');
      throw new Error('rollback invoice');
    }), /rollback invoice/);
    const counter = await asUser(owner, shop, tx => tx.query<{ value: number }>('select app_private.next_order_number() as value'));
    assert.equal(counter.rows[0]!.value, 2);

    const deletedOrder = randomUUID();
    await asUser(owner, shop, tx => tx.query(`insert into public.orders(id,shop_id,user_id,order_number)
      values ($1,$2,$3,app_private.next_order_number())`, [deletedOrder, shop, owner.user]));
    await db.query('update public.orders set deleted_at=now() where id=$1', [deletedOrder]);
    const refused = await asUser(owner, shop, tx => tx.query<{ done: boolean }>(
      'select app_private.mark_order_delivered($1) as done', [deletedOrder]));
    assert.equal(refused.rows[0]!.done, false, 'verification cannot deliver a soft-deleted order');
    const unchanged = await db.query<{ status: string }>('select status from public.orders where id=$1', [deletedOrder]);
    assert.equal(unchanged.rows[0]!.status, 'processing');

    const pending = randomUUID();
    await db.query("insert into auth_private.users(id,email,normalized_email) values ($1,'pending@example.test','pending@example.test')", [pending]);
    await db.transaction(async tx => {
      await tx.exec('set local role neuton_auth');
      await tx.query("select app_private.create_profile($1,'Pending user',NULL)", [pending]);
      await tx.query("insert into auth_private.security_events(event,result,correlation_id) values ('login','denied','synthetic')");
    });
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('set local role neuton_auth');
      await tx.exec("update auth_private.security_events set result='success'");
    }), /permission denied/);
    const price = (await asUser(owner, shop, tx => tx.query<{id:string}>(
      "select app_private.upsert_general_price('Flour','sku-1','flour','g','g','g',100,1) as id"))).rows[0]!.id;
    const foreignRecipe = (await asUser(other, foreignShop, tx => tx.query<{id:string}>(
      "insert into public.recipes(shop_id,name) values ($1,'Other recipe') returning id", [foreignShop]))).rows[0]!.id;
    for (const [account, selectedShop] of [[owner, shop], [other, foreignShop]] as const) {
      await asUser(account, selectedShop, tx => tx.query(`insert into public.recipe_ingredients(shop_id,recipe_id,general_price_id,
        raw_name,raw_material_name,quantity,raw_src_unit) select $1,id,$2,'flour','flour',100,'g' from public.recipes`, [selectedShop, price]));
    }
    const versions = (await db.query<{id:string;updated_at:string}>('select id,updated_at from public.document_versions where kind=\'recipe\'')).rows;
    await asUser(owner, shop, tx => tx.query("select app_private.upsert_general_price('Flour','sku-1','flour','g','g','g',100,2)"));
    const after = (await db.query<{id:string;updated_at:string}>('select id,updated_at from public.document_versions where kind=\'recipe\'')).rows;
    for (const version of versions) {
      assert.ok(BigInt(after.find(row => row.id === version.id)!.updated_at) > BigInt(version.updated_at));
    }
    await assert.rejects(asUser(owner, shop, tx => tx.query(`insert into public.recipe_ingredients(shop_id,recipe_id,raw_name,raw_material_name,quantity,raw_src_unit)
      values ($1,$2,'foreign','foreign',1,'g')`, [shop, foreignRecipe])), /foreign key/);

    const uploadId = randomUUID();
    const productRecipe = (await asUser(owner, shop, tx => tx.query<{id:string}>("insert into public.recipes(shop_id,name,status) values ($1,'Product placeholder','pending') returning id", [shop]))).rows[0]!.id;
    const sources = [1, 2].map(index => ({ sourceId: `source-${index}`, storagePath: `${shop}/${index}.webp`,
      contentType: 'image/webp', originalFilename: null, byteSize: 10 }));
    await asUser(owner, shop, tx => tx.query(`insert into public.media_uploads(id,shop_id,uploaded_by,kind,sources,recipe_id,queued_at)
      values ($1,$2,$3,'product',$4::jsonb,$5,now())`, [uploadId, shop, owner.user, JSON.stringify(sources), productRecipe]));
    await assert.rejects(asUser(owner, shop, tx => tx.query('update public.media_uploads set sources=$1::jsonb where id=$2',
      [JSON.stringify([...sources].reverse()), uploadId])), /Immutable upload source/);
    const job = (await asUser(owner, shop, tx => tx.query<{ id: string }>('select app_private.register_job($1) as id', [uploadId]))).rows[0]!.id;
    await db.query('update auth_private.sessions set revoked_at=now() where id=$1', [owner.session]);
    await assert.rejects(withUserTransaction(application, reference, async () => {}), /Active session/);
    await assert.rejects(withShopTransaction(application, reference, shop, async () => {}), /Active session/);
    await db.transaction(async tx => {
      await tx.exec('set local role neuton_worker');
      const claim = await tx.query('select * from app_private.claim_job_context($1)', [job]);
      assert.equal(claim.rows.length, 1, 'logout must not cancel accepted work');
      const result = await tx.query("update public.recipes set description='Worker product' where id=$1 returning id", [productRecipe]);
      assert.equal(result.rows.length, 1);
      assert.equal((await tx.query("update public.recipes set description='Forbidden' where id<>$1 returning id", [productRecipe])).rows.length, 0);
    });
    await assert.rejects(db.transaction(async tx => {
      await tx.exec('set local role neuton_worker');
      await tx.query('select * from app_private.claim_job_context($1)', [job]);
      await tx.query(`insert into public.inventory_items(shop_id,name,raw_material_name,unit,base_unit,base_unit_amount,base_unit_cost)
        values ($1,'Forbidden','forbidden','g','g',100,1)`, [shop]);
    }), /permission denied/);
    await db.query("update auth_private.users set status='disabled',security_version=security_version+1 where id=$1", [owner.user]);
    await db.transaction(async tx => {
      await tx.exec('set local role neuton_worker');
      assert.equal((await tx.query('select * from app_private.claim_job_context($1)', [job])).rows.length, 0);
      assert.equal((await tx.query<{done:boolean}>('select app_private.finish_job($1,$2) as done', [job, 'cancelled'])).rows[0]!.done, true);
    });
    const lease = randomUUID();
    const oldSession = randomUUID();
    await db.query(`insert into auth_private.sessions(id,user_id,token_digest,csrf_digest,security_version,authenticated_at,
      authentication_method,last_activity_at,idle_expires_at,absolute_expires_at,revoked_at)
      values ($1,$2,$3,$3,1,now()-interval '60 days','password',now()-interval '60 days',now()-interval '53 days',now()-interval '30 days',now()-interval '40 days')`,
    [oldSession, owner.user, 'f'.repeat(64)]);
    await db.query("insert into auth_private.security_events(session_id,event,result,correlation_id) values ($1,'logout','success','retained-event')", [oldSession]);
    await db.exec("insert into auth_private.security_events(event,result,correlation_id,created_at) values ('login','denied','expired-event',now()-interval '91 days')");
    await db.query('insert into public.storage_object_deletions(shop_id,storage_path,trace_id) values ($1,$2,$3)', [shop, `${shop}/obsolete.webp`, 'synthetic']);
    await db.query('delete from public.shops where id=$1', [shop]);
    await db.transaction(async tx => {
      await tx.exec('set local role neuton_cleanup');
      const rows = await tx.query<{ id: string }>('select * from app_private.claim_storage_deletions($1)', [lease]);
      assert.equal(rows.rows.length, 1, 'storage cleanup survives source-shop deletion');
      const id = rows.rows[0]!.id;
      assert.equal((await tx.query<{done:boolean}>('select app_private.complete_storage_deletion($1,$2) as done', [id, randomUUID()])).rows[0]!.done, false);
      assert.equal((await tx.query<{done:boolean}>('select app_private.complete_storage_deletion($1,$2) as done', [id, lease])).rows[0]!.done, true);
      await tx.query('select app_private.cleanup_auth_records()');
    });
    assert.equal((await db.query('select id from auth_private.sessions where id=$1', [oldSession])).rows.length, 0);
    assert.equal((await db.query("select id from auth_private.security_events where correlation_id='expired-event'")).rows.length, 0);
    assert.equal((await db.query<{session_id:string|null}>("select session_id from auth_private.security_events where correlation_id='retained-event'")).rows[0]!.session_id, null);
  } finally {
    await db.close();
  }
});

test('guarded runner applies and replays the complete fresh chain without drift or seeding accounts', async () => {
  const db = new PGlite();
  try {
    for (const role of ['neuton_app','neuton_auth','neuton_worker','neuton_cleanup','neuton_policy_reader','neuton_bootstrap']) {
      await db.exec(`create role ${role} nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`);
    }
    const directory = new URL('../drizzle-neon/', import.meta.url);
    const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => {
      const source = readFileSync(new URL(name, directory), 'utf8');
      return { name, sql: source, checksum: migrationChecksum(source) };
    });
    const database: MigrationDatabase = {
      transaction(work) {
        return db.transaction(transaction => work({
          async query<T extends Record<string, unknown>>(statement: string, parameters: string[] = []) {
            return (await transaction.query<T>(statement, parameters)).rows;
          },
          async execute(statement) { await transaction.exec(statement); },
        }));
      },
    };
    assert.equal((await runMigrationBatch(database, files)).length, files.length);
    assert.deepEqual(await runMigrationBatch(database, files), []);
    assert.equal((await db.query<{count:number}>('select count(*)::int as count from auth_private.users')).rows[0]!.count, 0);
    const last = files.at(-1)!;
    const changed = last.sql + '\n-- modified after application';
    await assert.rejects(runMigrationBatch(database, [
      ...files.slice(0, -1), { ...last, sql: changed, checksum: migrationChecksum(changed) },
    ]), /unchanged prefix/);
  } finally {
    await db.close();
  }
});

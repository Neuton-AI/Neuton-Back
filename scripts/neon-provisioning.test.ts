import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProvisioningRoles, assertRestrictedRole } from '../src/db/provisioning.js';
import { provisionRoleTransaction } from '../src/db/provisioning.js';
import { provisioningFailureMessage } from '../src/db/provisioning-cli.js';
import { PGlite } from '@electric-sql/pglite';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';

test('provisioning defines restricted roles without requiring future runtime credentials', () => {
  const roles = readProvisioningRoles();
  assert.deepEqual(roles.filter(role => role.login).map(role => role.name),
    ['neuton_app', 'neuton_auth', 'neuton_worker', 'neuton_cleanup']);
  assert.deepEqual(roles.filter(role => !role.login).map(role => role.name),
    ['neuton_policy_reader', 'neuton_bootstrap', 'neuton_maintenance']);
  for (const role of roles) assert.equal('password' in role, false);
});

test('existing runtime roles fail closed for privilege, membership or ownership drift', () => {
  const safe = { rolcanlogin: true, rolsuper: false, rolcreatedb: false,
    rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false,
    memberships: 0, ownedObjects: 0 };
  assert.doesNotThrow(() => assertRestrictedRole('neuton_app', true, safe));
  for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit']) {
    assert.throws(() => assertRestrictedRole('neuton_app', true, { ...safe, [flag]: true }));
  }
  assert.throws(() => assertRestrictedRole('neuton_app', true, { ...safe, memberships: 1 }));
  assert.throws(() => assertRestrictedRole('neuton_app', true, { ...safe, ownedObjects: 1 }));
  assert.throws(() => assertRestrictedRole('neuton_policy_reader', false, safe));
});

test('owner-only provisioning initializes restricted LOGIN passwords without returning credentials and preserves resets', async () => {
  const database = new PGlite();
  try {
    const provision = () => database.transaction(async native => {
      const query = (parts: string | TemplateStringsArray, ...values: unknown[]) => {
        if (typeof parts === 'string') return { identifier: parts };
        const parameters: unknown[] = [];
        let statement = parts[0]!;
        for (let index = 0; index < values.length; index++) {
          const value = values[index];
          if (value && typeof value === 'object' && 'identifier' in value) {
            statement += '"' + String(value.identifier).replaceAll('"', '""') + '"';
          } else {
            parameters.push(value);
            statement += '$' + parameters.length;
          }
          statement += parts[index + 1]!;
        }
        return native.query(statement, parameters).then(result => result.rows);
      };
      const transaction = Object.assign(query, { unsafe: (statement: string) => native.exec(statement) });
      await provisionRoleTransaction(transaction as unknown as postgres.TransactionSql);
    });
    await provision();
    const roles = (await database.query<{ rolname: string; rolcanlogin: boolean; rolpassword: string | null; rolinherit: boolean; rolbypassrls: boolean }>(
      "select rolname,rolcanlogin,rolpassword,rolinherit,rolbypassrls from pg_authid where rolname like 'neuton_%' order by rolname")).rows;
    assert.equal(roles.length, 7);
    for (const role of roles) {
      assert.equal(role.rolpassword !== null, role.rolcanlogin);
      assert.equal(role.rolinherit, false);
      assert.equal(role.rolbypassrls, false);
      assert.equal(role.rolcanlogin, ['neuton_app', 'neuton_auth', 'neuton_worker', 'neuton_cleanup'].includes(role.rolname));
    }
    await database.exec("alter role neuton_app password 'synthetic-test-password-only'");
    const password = async () => (await database.query<{ rolpassword: string }>("select rolpassword from pg_authid where rolname='neuton_app'")).rows[0]!.rolpassword;
    const before = await password();
    await provision();
    assert.equal(await password(), before);
    for (const role of roles.filter(role => role.rolcanlogin)) {
      await database.exec(`alter role ${role.rolname} password null`);
    }
    await database.exec(readFileSync(new URL('./initialize-runtime-passwords.sql', import.meta.url), 'utf8'));
    assert.equal((await database.query<{ count: number }>(
      "select count(*)::integer as count from pg_authid where rolname in ('neuton_app','neuton_auth','neuton_worker','neuton_cleanup') and rolpassword is not null")).rows[0]!.count, 4);
    await database.exec('create table public.existing_application(id integer)');
    await assert.rejects(provision, /requires an empty application database/);
  } finally { await database.close(); }
});

test('provisioning diagnostics never echo driver messages or supplied credentials', () => {
  const secret = 'postgresql://owner:private-password@private-host/private-database';
  for (const code of ['42501', '28P01', 'ENOTFOUND', 'UNKNOWN']) {
    const message = provisioningFailureMessage(Object.assign(new Error(secret), { code }));
    assert.doesNotMatch(message, /private-|postgresql/);
  }
  assert.match(provisioningFailureMessage(new Error('Invalid authentication configuration: MIGRATION_DATABASE_URL')), /OWNER/);
});

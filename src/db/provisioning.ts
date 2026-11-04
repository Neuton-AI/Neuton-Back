import postgres from 'postgres';
import { databaseUrl } from '../config/database.js';
import type { EnvironmentSource } from '../config/database.js';

interface ProvisioningRole { name: string; login: boolean }
interface RoleAttributes {
  rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
  rolreplication: boolean; rolbypassrls: boolean; rolinherit: boolean;
  memberships: number; ownedObjects: number;
}

export function readProvisioningRoles(): ProvisioningRole[] {
  return [
    { name: 'neuton_app', login: true },
    { name: 'neuton_auth', login: true },
    { name: 'neuton_worker', login: true },
    { name: 'neuton_cleanup', login: true },
    { name: 'neuton_policy_reader', login: false },
    { name: 'neuton_bootstrap', login: false },
    { name: 'neuton_maintenance', login: false },
  ];
}

export function assertRestrictedRole(name: string, login: boolean, role: RoleAttributes): void {
  if (role.rolcanlogin !== login || role.rolsuper || role.rolcreatedb || role.rolcreaterole ||
    role.rolreplication || role.rolbypassrls || role.rolinherit || role.memberships > 0 ||
    (login && role.ownedObjects > 0)) {
    throw new Error(`Unsafe existing database role: ${name}`);
  }
}

export async function provisionNeonRoles(source: EnvironmentSource): Promise<void> {
  const ownerUrl = databaseUrl(source, 'MIGRATION_DATABASE_URL');
  const connection = postgres(ownerUrl, { max: 1, prepare: false,
    ssl: { rejectUnauthorized: true }, connect_timeout: 15, onnotice: () => {} });
  try {
    await connection.begin(provisionRoleTransaction);
  } finally {
    await connection.end({ timeout: 5 });
  }
}

/** The owner transaction creates roles before any runtime credentials exist. */
export async function provisionRoleTransaction(tx: postgres.TransactionSql): Promise<void> {
  const roles = readProvisioningRoles();

  await tx`select pg_advisory_xact_lock(hashtextextended('neuton:migrations', 0))`;
  const [relations] = await tx<{ count: number }[]>`
    select count(*)::integer as count from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public', 'auth_private', 'app_private')
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and not exists (select 1 from pg_catalog.pg_depend d
        where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
  if (!relations || relations.count > 0) {
    throw new Error('Role provisioning requires an empty application database');
  }
  for (const role of roles) {
    const existing = await tx<(RoleAttributes & { rolname: string })[]>`
      select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
        r.rolreplication, r.rolbypassrls, r.rolinherit,
        (select count(*)::integer from pg_catalog.pg_auth_members m where m.member=r.oid) as memberships,
        ((select count(*) from pg_catalog.pg_class c where c.relowner=r.oid) +
         (select count(*) from pg_catalog.pg_namespace n where n.nspowner=r.oid) +
         (select count(*) from pg_catalog.pg_proc p where p.proowner=r.oid))::integer as "ownedObjects"
      from pg_catalog.pg_roles r where r.rolname=${role.name}`;
    const current = existing[0];
    if (current) {
      assertRestrictedRole(role.name, role.login, current);
      continue;
    }
    let statement: string;
    if (role.login) {
      const [row] = await tx<{ statement: string }[]>`
        select format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', ${role.name}::text) as statement`;
      statement = row!.statement;
    } else {
      const [row] = await tx<{ statement: string }[]>`
        select format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', ${role.name}::text) as statement`;
      statement = row!.statement;
    }
    await tx.unsafe(statement);
  }
  const [database] = await tx<{ name: string }[]>`select current_database() as name`;
  await tx`revoke all on database ${tx(database!.name)} from public`;
  await tx`revoke all on schema public from public`;
  for (const role of roles.filter(role => role.login)) {
    await tx`revoke all on database ${tx(database!.name)} from ${tx(role.name)}`;
    await tx`grant connect on database ${tx(database!.name)} to ${tx(role.name)}`;
    await tx`revoke all on schema public from ${tx(role.name)}`;
  }
  await tx`alter default privileges revoke all on tables from public`;
  await tx`alter default privileges revoke all on sequences from public`;
  await tx`alter default privileges revoke execute on functions from public`;
}

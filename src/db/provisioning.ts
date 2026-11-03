import postgres from 'postgres';
import { databaseUrl, invalidConfig } from '../config/database.js';
import type { EnvironmentSource } from '../config/database.js';

interface ProvisioningRole { name: string; login: boolean; password?: string }
interface RoleAttributes {
  rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
  rolreplication: boolean; rolbypassrls: boolean; rolinherit: boolean;
  memberships: number; ownedObjects: number;
}

export function readProvisioningRoles(source: EnvironmentSource): ProvisioningRole[] {
  const roles: ProvisioningRole[] = [];
  for (const [field, name] of [
    ['DATABASE_URL', 'neuton_app'], ['AUTH_DATABASE_URL', 'neuton_auth'],
    ['WORKER_DATABASE_URL', 'neuton_worker'], ['CLEANUP_DATABASE_URL', 'neuton_cleanup'],
  ] as const) {
    const url = new URL(databaseUrl(source, field, name));
    let password: string;
    try {
      password = decodeURIComponent(url.password);
    } catch {
      invalidConfig(field);
    }
    roles.push({ name, login: true, password });
  }
  roles.push({ name: 'neuton_policy_reader', login: false }, { name: 'neuton_bootstrap', login: false });
  return roles;
}

export function assertRestrictedRole(name: string, login: boolean, role: RoleAttributes): void {
  if (role.rolcanlogin !== login || role.rolsuper || role.rolcreatedb || role.rolcreaterole ||
    role.rolreplication || role.rolbypassrls || role.rolinherit || role.memberships > 0 ||
    (login && role.ownedObjects > 0)) {
    throw new Error(`Unsafe existing database role: ${name}`);
  }
}

export async function provisionNeonRoles(source: EnvironmentSource): Promise<void> {
  const roles = readProvisioningRoles(source);
  const ownerUrl = databaseUrl(source, 'MIGRATION_DATABASE_URL');
  const ownerDatabase = new URL(ownerUrl).pathname;
  for (const field of ['DATABASE_URL', 'AUTH_DATABASE_URL', 'WORKER_DATABASE_URL', 'CLEANUP_DATABASE_URL']) {
    if (new URL(source[field]!).pathname !== ownerDatabase) invalidConfig(field);
  }
  const connection = postgres(ownerUrl, { max: 1, prepare: false,
    ssl: { rejectUnauthorized: true }, connect_timeout: 15, onnotice: () => {} });
  try {
    await connection.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended('neuton:role-provisioning', 0))`;
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
            select format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L', ${role.name}, ${role.password!}) as statement`;
          statement = row!.statement;
        } else {
          const [row] = await tx<{ statement: string }[]>`
            select format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', ${role.name}) as statement`;
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
    });
  } finally {
    await connection.end({ timeout: 5 });
  }
}

import { createHash } from 'node:crypto';

export const BASELINE_FILE = '0000_neuton_baseline.sql';
export const BASELINE_ID = 'neuton-auth-neon-v1';
export interface MigrationDigest { name: string; checksum: string }
export interface MigrationFile extends MigrationDigest { sql: string }
export class MigrationError extends Error {}

/** Keep connection strings, SQL and driver details out of command output. */
export function migrationFailureMessage(error: unknown): string {
  if (error instanceof MigrationError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message === 'Invalid authentication configuration: MIGRATION_DATABASE_URL') {
    return 'Neon migration failed: MIGRATION_DATABASE_URL is missing or invalid. Use the owner connection for the target database.';
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'CHANNEL_BINDING_REQUIRED') return 'Neon migration failed: the endpoint did not complete required channel-bound authentication.';
  if (code === '28P01') return 'Neon migration failed: the owner username or password was rejected.';
  if (code === '42501') {
    const role = ['neuton_policy_reader', 'neuton_bootstrap', 'neuton_maintenance'].find(name =>
      message === `must be able to SET ROLE "${name}"` || message === `permission denied to set role "${name}"`);
    if (role) return `Neon migration failed: the migration owner needs SET ROLE permission for ${role}.`;
    const permission = /^(permission denied for|must be owner of) (schema|table|function|sequence) "?([a-z_][a-z0-9_]{0,100})"?$/.exec(message);
    if (permission) return `Neon migration failed: ${permission[1]} ${permission[2]} ${permission[3]} (SQLSTATE 42501).`;
    return 'Neon migration failed: the migration owner lacks required database permissions (SQLSTATE 42501).';
  }
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    return `Neon migration failed (SQLSTATE ${code}). No credentials or SQL details were logged.`;
  }
  return 'Neon migration failed. Check migration-only configuration, connectivity and the approved SQL chain.';
}

export interface MigrationTransaction {
  query<T extends Record<string, unknown>>(statement: string, parameters?: string[]): Promise<T[]>;
  execute(statement: string): Promise<void>;
}
export interface MigrationDatabase {
  transaction(work: (transaction: MigrationTransaction) => Promise<string[]>): Promise<string[]>;
}

export function migrationChecksum(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex');
}

export function validateMigrationHistory(files: MigrationDigest[], applied: MigrationDigest[]): void {
  if (files[0]?.name !== BASELINE_FILE || applied.length > files.length) {
    throw new MigrationError('The approved Neon baseline or migration history is missing');
  }
  let previousName = '';
  for (const file of files) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file.name) || file.name <= previousName ||
      !/^[a-f0-9]{64}$/.test(file.checksum)) {
      throw new MigrationError('Invalid ordered Neon migration manifest');
    }
    previousName = file.name;
  }
  for (const [index, migration] of applied.entries()) {
    const expected = files[index];
    if (migration.name !== expected?.name || migration.checksum !== expected.checksum) {
      throw new MigrationError('Applied Neon migrations differ from the approved unchanged prefix');
    }
  }
}

export async function runMigrationBatch(database: MigrationDatabase, files: MigrationFile[]): Promise<string[]> {
  validateMigrationHistory(files, []);
  for (const file of files) {
    if (!file.sql.trim() || file.checksum !== migrationChecksum(file.sql)) {
      throw new MigrationError('Migration content does not match its manifest');
    }
  }
  return database.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('neuton:migrations', 0))");
    const [state] = await tx.query<{ marker: string | null; legacy: string | null }>(`
      select to_regclass('app_private.schema_metadata')::text as marker,
        coalesce(to_regclass('public.__neuton_migrations'),
          to_regclass('drizzle.__drizzle_migrations'))::text as legacy`);
    if (state?.legacy) throw new MigrationError('Legacy migration ledger is incompatible with fresh Neon initialization');
    if (!state?.marker) {
      const [existing] = await tx.query<{ count: number }>(`
        select count(*)::integer as count from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public', 'auth_private', 'app_private', 'drizzle')
          and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and not exists (select 1 from pg_catalog.pg_depend d
            where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`);
      if (!existing || existing.count > 0) {
        throw new MigrationError('Initial Neon migration requires an empty application database');
      }
      await tx.execute(`
        create schema if not exists app_private;
        revoke all on schema app_private from public;
        create table app_private.schema_metadata (
          name text primary key, version integer not null check (version=1),
          initialized_at timestamptz not null default now());
        create table app_private.schema_migrations (
          name text primary key, checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
          applied_at timestamptz not null default now());
        revoke all on app_private.schema_metadata, app_private.schema_migrations from public;
      `);
    } else {
      const markers = await tx.query<{ name: string; version: number }>(
        'select name, version from app_private.schema_metadata');
      if (markers.length !== 1 || markers[0]?.name !== BASELINE_ID || markers[0].version !== 1) {
        throw new MigrationError('Incompatible Neon baseline marker');
      }
    }
    const applied = await tx.query<MigrationDigest & Record<string, unknown>>(
      'select name, checksum from app_private.schema_migrations order by name');
    validateMigrationHistory(files, applied);
    if (state?.marker && applied.length === 0) {
      throw new MigrationError('Baseline marker exists without its migration record');
    }
    const completed: string[] = [];
    for (const migration of files.slice(applied.length)) {
      await tx.execute(migration.sql);
      await tx.query('insert into app_private.schema_migrations (name,checksum) values ($1,$2)',
        [migration.name, migration.checksum]);
      if (migration.name === BASELINE_FILE) {
        await tx.query('insert into app_private.schema_metadata (name,version) values ($1,1)', [BASELINE_ID]);
      }
      completed.push(migration.name);
    }
    return completed;
  });
}

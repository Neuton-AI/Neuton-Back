import { createHash } from 'node:crypto';

export const BASELINE_FILE = '0000_neuton_baseline.sql';
export const BASELINE_ID = 'neuton-auth-neon-v1';
export interface MigrationDigest { name: string; checksum: string }
export interface MigrationFile extends MigrationDigest { sql: string }
export class MigrationError extends Error {}

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

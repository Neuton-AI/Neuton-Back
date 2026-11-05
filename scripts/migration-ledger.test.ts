import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrationChecksum, migrationFailureMessage, runMigrationBatch, validateMigrationHistory, BASELINE_FILE } from '../src/db/migration-ledger.js';
import type { MigrationDatabase } from '../src/db/migration-ledger.js';

const baseline = { name: BASELINE_FILE, checksum: migrationChecksum('baseline') };
const later = { name: '0001_next.sql', checksum: migrationChecksum('next') };

test('migration checksums normalize line endings and retain the full SHA-256 digest', () => {
  assert.equal(migrationChecksum('one\r\ntwo'), migrationChecksum('one\ntwo'));
  assert.equal(migrationChecksum('baseline').length, 64);
  assert.notEqual(migrationChecksum('baseline'), migrationChecksum('baseline changed'));
});

test('migration diagnostics identify bounded permission failures without logging driver secrets', () => {
  assert.match(migrationFailureMessage(Object.assign(new Error('must be able to SET ROLE "neuton_policy_reader"'), { code: '42501' })), /SET ROLE.*neuton_policy_reader/);
  assert.match(migrationFailureMessage(Object.assign(new Error('permission denied for function context_uuid'), { code: '42501' })), /function context_uuid/);
  for (const code of ['42501', '28P01', '42P01', 'CHANNEL_BINDING_REQUIRED', 'UNKNOWN']) {
    const result = migrationFailureMessage(Object.assign(new Error('postgresql://private-user:private-password@private-host/private-db'), { code }));
    assert.doesNotMatch(result, /private-|postgresql:\/\//);
  }
});

test('migration history must be a complete unchanged prefix starting at the approved baseline', () => {
  assert.doesNotThrow(() => validateMigrationHistory([baseline, later], []));
  assert.doesNotThrow(() => validateMigrationHistory([baseline, later], [baseline]));
  assert.throws(() => validateMigrationHistory([later], []));
  assert.throws(() => validateMigrationHistory([baseline, later], [later]));
  assert.throws(() => validateMigrationHistory([baseline, later], [baseline, baseline]));
  assert.throws(() => validateMigrationHistory([baseline], [baseline, later]));
  assert.throws(() => validateMigrationHistory([baseline, later], [{ ...baseline, checksum: 'modified' }]));
});

test('fresh runner rejects historical ledgers, populated databases and incompatible markers without applying SQL', async () => {
  const cases = [
    { setup: 'create table public.__neuton_migrations(id integer)', reason: /Legacy migration ledger/ },
    { setup: 'create schema drizzle; create table drizzle.__drizzle_migrations(id integer)', reason: /Legacy migration ledger/ },
    { setup: 'create table public.existing_business(id integer)', reason: /empty application database/ },
    { setup: "create schema app_private; create table app_private.schema_metadata(name text, version integer); insert into app_private.schema_metadata values ('other-baseline', 1)", reason: /Incompatible Neon baseline marker/ },
  ];
  for (const scenario of cases) {
    const db = new PGlite();
    let applied = false;
    try {
      await db.exec(scenario.setup);
      const database: MigrationDatabase = {
        transaction(work) {
          return db.transaction(transaction => work({
            async query<T extends Record<string, unknown>>(statement: string, parameters: string[] = []) {
              return (await transaction.query<T>(statement, parameters)).rows;
            },
            async execute(statement) {
              applied = true;
              await transaction.exec(statement);
            },
          }));
        },
      };
      const sql = 'select 1';
      await assert.rejects(runMigrationBatch(database, [{ name: BASELINE_FILE, checksum: migrationChecksum(sql), sql }]), scenario.reason);
      assert.equal(applied, false);
    } finally {
      await db.close();
    }
  }
});

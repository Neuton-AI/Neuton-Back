import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationChecksum, validateMigrationHistory, BASELINE_FILE } from '../src/db/migration-ledger.js';

const baseline = { name: BASELINE_FILE, checksum: migrationChecksum('baseline') };
const later = { name: '0001_next.sql', checksum: migrationChecksum('next') };

test('migration checksums normalize line endings and retain the full SHA-256 digest', () => {
  assert.equal(migrationChecksum('one\r\ntwo'), migrationChecksum('one\ntwo'));
  assert.equal(migrationChecksum('baseline').length, 64);
  assert.notEqual(migrationChecksum('baseline'), migrationChecksum('baseline changed'));
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

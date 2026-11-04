import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabaseConnection } from '../src/db/connection.js';

test('connection factories use only their role-specific setting and force certificate validation', async () => {
  for (const [kind, field, role] of [
    ['app', 'DATABASE_URL', 'neuton_app'], ['auth', 'AUTH_DATABASE_URL', 'neuton_auth'],
    ['worker', 'WORKER_DATABASE_URL', 'neuton_worker'], ['cleanup', 'CLEANUP_DATABASE_URL', 'neuton_cleanup'],
    ['migration', 'MIGRATION_DATABASE_URL', 'neondb_owner'],
  ] as const) {
    const connection = createDatabaseConnection(kind, {
      [field]: `postgresql://${role}:synthetic@db.example/neuton?sslmode=require`,
    });
    try {
      assert.deepEqual(connection.options.ssl, { rejectUnauthorized: true });
      assert.equal(connection.options.user, role);
      assert.equal(connection.options.prepare, false);
      assert.equal(connection.options.channel_binding, 'require');
      assert.equal(connection.options.infer, true);
      assert.equal(connection.options.max, kind === 'migration' ? 1 : 10);
    } finally {
      await connection.end();
    }
  }
});

test('runtime connections never fall back to an owner URL or another process URL', () => {
  const source = { MIGRATION_DATABASE_URL: 'postgresql://neondb_owner:synthetic@db.example/neuton' };
  assert.throws(() => createDatabaseConnection('app', source), /DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('auth', source), /AUTH_DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('worker', source), /WORKER_DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('cleanup', source), /CLEANUP_DATABASE_URL/);
});

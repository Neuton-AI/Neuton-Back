import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabaseConnection } from '../src/db/connection.js';
import { listenDatabaseUrl } from '../src/config/database.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

test('LISTEN requires its own direct app-role URL and never falls back to another connection', () => {
  const direct = 'postgresql://neuton_app:synthetic@db.example/neuton?sslmode=require';
  assert.equal(listenDatabaseUrl({ DATABASE_LISTEN_URL: direct }), direct);
  assert.throws(() => listenDatabaseUrl({ DATABASE_URL: direct }), /DATABASE_LISTEN_URL/);
  assert.throws(() => listenDatabaseUrl({ DATABASE_LISTEN_URL: direct.replace('db.example', 'ep-example-pooler.neon.tech') }), /DATABASE_LISTEN_URL/);
  assert.throws(() => listenDatabaseUrl({ DATABASE_LISTEN_URL: direct.replace('neuton_app:', 'neuton_auth:') }), /DATABASE_LISTEN_URL/);
});

test('importing the worker requires no app, auth, migration, SMTP or Google credentials', async () => {
  const script = `await import('./scripts/support/testEnv.ts');
    for (const key of Object.keys(process.env)) {
      if (/DATABASE|SMTP|MAIL_|GOOGLE|AUTH_/.test(key)) delete process.env[key];
    }
    await import('./src/worker.ts');
    console.log('worker-imported');`;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 15000, windowsHide: true,
  });
  assert.match(result.stdout, /worker-imported/);
});

test('runtime connections never fall back to an owner URL or another process URL', () => {
  const source = { MIGRATION_DATABASE_URL: 'postgresql://neondb_owner:synthetic@db.example/neuton' };
  assert.throws(() => createDatabaseConnection('app', source), /DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('auth', source), /AUTH_DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('worker', source), /WORKER_DATABASE_URL/);
  assert.throws(() => createDatabaseConnection('cleanup', source), /CLEANUP_DATABASE_URL/);
});

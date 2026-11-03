import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProvisioningRoles, assertRestrictedRole } from '../src/db/provisioning.js';

const source = {
  DATABASE_URL: 'postgresql://neuton_app:app-password@db.example/neuton',
  AUTH_DATABASE_URL: 'postgresql://neuton_auth:auth-password@db.example/neuton',
  WORKER_DATABASE_URL: 'postgresql://neuton_worker:worker-password@db.example/neuton',
  CLEANUP_DATABASE_URL: 'postgresql://neuton_cleanup:cleanup-password@db.example/neuton',
};

test('provisioning takes passwords from role-specific URLs and never invents owner access', () => {
  const roles = readProvisioningRoles(source);
  assert.equal(roles.length, 7);
  assert.equal(roles.find(role => role.name === 'neuton_auth')?.password, 'auth-password');
  assert.equal(roles.find(role => role.name === 'neuton_policy_reader')?.login, false);
  assert.equal(roles.find(role => role.name === 'neuton_bootstrap')?.password, undefined);
  assert.throws(() => readProvisioningRoles({ ...source, AUTH_DATABASE_URL: source.DATABASE_URL }));
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

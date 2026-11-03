import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { authUsers, passwordCredentials, googleIdentities, authSessions } from '../src/db/schema/auth.js';
import * as businessSchema from '../src/db/schema/index.js';
import { profiles } from '../src/db/schema/identity.js';

test('private auth relations are separate from business exports and profiles reference local users', () => {
  for (const table of [authUsers, passwordCredentials, googleIdentities, authSessions]) {
    assert.equal(getTableConfig(table).schema, 'auth_private');
    assert.ok(!Object.values(businessSchema).includes(table as never));
  }
  const profileFk = getTableConfig(profiles).foreignKeys.find(key => key.reference().foreignTable === authUsers);
  assert.ok(profileFk);
});

test('credential/session identities and expiry indexes are explicitly represented', () => {
  assert.equal(passwordCredentials.userId.primary, true);
  assert.equal(authSessions.tokenDigest.notNull, true);
  assert.equal(authSessions.csrfDigest.notNull, true);
  assert.ok(getTableConfig(authSessions).indexes.length >= 3);
  assert.ok(getTableConfig(googleIdentities).indexes.filter(index => index.config.unique).length >= 2);
  assert.ok(getTableConfig(authUsers).checks.length >= 2);
});

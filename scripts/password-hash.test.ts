import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/modules/identity/password-hash.js';

test('password hashes use salted Argon2id and require the exact password', async () => {
  const password = ' my exact password ';
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword(password), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgonPasswordHasher } from '../src/modules/auth/password-hasher.js';

test('Argon2id uses the approved parameters, unique salts and exact password text', async () => {
  const hasher = new ArgonPasswordHasher();
  const password = '  Fifteen 😀 characters and more  ';
  const first = await hasher.hash(password);
  const second = await hasher.hash(password);
  assert.match(first, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(await hasher.verify(first, password), true);
  assert.equal(await hasher.verify(first, password.trim()), false);
  assert.equal(await hasher.verify(first, password.toLowerCase()), false);
  assert.equal(hasher.needsRehash(first), false);
  assert.equal(hasher.needsRehash(first.replace('t=3', 't=2')), true);
  assert.equal(hasher.needsRehash(first.replace('argon2id', 'argon2i')), true);
  assert.equal(await hasher.verifyDummy(password), undefined);
  assert.equal(await hasher.verifyDummy('synthetic dummy comparison only'), undefined);
  await assert.rejects(hasher.hash('short'), { code: 'BAD_REQUEST' });
});

test('hash and comparison share bounded capacity without an unbounded waiting queue', async () => {
  const hasher = new ArgonPasswordHasher(1);
  const running = hasher.hash('a long valid password');
  await assert.rejects(new ArgonPasswordHasher(1).verifyDummy('a long valid password'), {
    statusCode: 503, code: 'AUTH_HASH_UNAVAILABLE',
  });
  const encoded = await running;
  assert.equal(await hasher.verify(encoded, 'a long valid password'), true);
  await assert.rejects(hasher.verify('broken private hash', 'a long valid password'), {
    statusCode: 503, message: 'Password authentication temporarily unavailable',
  });
  assert.equal(await hasher.verify(encoded, 'a long valid password'), true);
  assert.throws(() => new ArgonPasswordHasher(5));
});

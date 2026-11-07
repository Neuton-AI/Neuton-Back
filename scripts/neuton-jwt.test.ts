import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { SignJWT } from 'jose';
import { NeutonJwt } from '../src/modules/identity/neuton-jwt.js';
import { hashPassword, verifyPassword } from '../src/modules/identity/password-hash.js';

test('password hashes use salted Argon2id and require the exact password', async () => {
  const password = ' my exact password ';
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$/);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword(password), false);
});

test('Neuton JWTs verify only with the configured key and valid claims', async () => {
  const key = randomBytes(32);
  const tokens = new NeutonJwt(key);
  const user = { id: randomUUID(), email: 'user@example.com' };
  const token = await tokens.issue(user);

  assert.deepEqual(await tokens.verify(token), user);
  assert.equal(await new NeutonJwt(randomBytes(32)).verify(token), null);
  assert.equal(await tokens.verify('invalid'), null);

  for (const options of [
    { issuer: 'neuton', expiresAt: '0s', subject: user.id, algorithm: 'HS256' },
    { issuer: 'neuton', expiresAt: undefined, subject: user.id, algorithm: 'HS256' },
    { issuer: 'another-app', expiresAt: '1h', subject: user.id, algorithm: 'HS256' },
    { issuer: 'neuton', expiresAt: '1h', subject: 'not-a-uuid', algorithm: 'HS256' },
    { issuer: 'neuton', expiresAt: '1h', subject: user.id, algorithm: 'HS384' },
  ]) {
    const jwt = new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: options.algorithm, typ: 'JWT' })
      .setIssuer(options.issuer)
      .setAudience('neuton-api')
      .setSubject(options.subject)
      .setIssuedAt();
    if (options.expiresAt) jwt.setExpirationTime(options.expiresAt);
    assert.equal(await tokens.verify(await jwt.sign(key)), null);
  }
});

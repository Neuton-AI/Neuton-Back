import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthEncryption, digestSecret, newSecret, rateLimitDigest, secretMatches } from '../src/modules/auth/crypto.js';

test('bearer secrets are independent 32-byte values with purpose-bound digests', () => {
  const secrets = Array.from({ length: 100 }, () => newSecret());
  assert.equal(new Set(secrets).size, 100);
  for (const secret of secrets) {
    assert.equal(secret.length, 43);
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    const digest = digestSecret('session', secret);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(secretMatches('session', secret, digest), true);
    assert.equal(secretMatches('confirm_email', secret, digest), false);
    assert.equal(secretMatches('session', newSecret(), digest), false);
  }
  assert.equal(secretMatches('session', 'malformed', 'a'.repeat(64)), false);
  assert.equal(secretMatches('session', secrets[0]!, 'not a digest'), false);
});

test('rate dimensions are keyed, environment-separated and do not expose the address', () => {
  const secret = Buffer.alloc(32, 31);
  const digest = rateLimitDigest(secret, 'dev', 'login-account', 'alice@example.com');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest.includes('alice'), false);
  assert.notEqual(digest, rateLimitDigest(secret, 'prod', 'login-account', 'alice@example.com'));
  assert.notEqual(digest, rateLimitDigest(secret, 'dev', 'mail-destination', 'alice@example.com'));
  assert.notEqual(digest, rateLimitDigest(Buffer.alloc(32, 32), 'dev', 'login-account', 'alice@example.com'));
  assert.throws(() => rateLimitDigest(Buffer.alloc(1), 'dev', 'login-account', 'alice@example.com'));
});

test('encrypted payloads bind key, purpose and record with fresh nonces', () => {
  const encryption = new AuthEncryption('v1', new Map([['v1', Buffer.alloc(32, 17)]]));
  const envelope = encryption.encrypt('mail:confirm_email', 'record-1', 'private link secret');
  assert.equal(envelope.keyId, 'v1');
  assert.equal(encryption.decrypt('mail:confirm_email', 'record-1', envelope), 'private link secret');
  assert.notEqual(envelope.ciphertext, encryption.encrypt('mail:confirm_email', 'record-1', 'private link secret').ciphertext);
  assert.equal(envelope.ciphertext.includes('private link'), false);
  for (const [purpose, record] of [['oauth_pkce', 'record-1'], ['mail:confirm_email', 'record-2']] as const) {
    assert.throws(() => encryption.decrypt(purpose!, record!, envelope), { code: 'AUTH_SECRET_UNAVAILABLE' });
  }
  const parts = envelope.ciphertext.split('.');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');
  ciphertext[0] = ciphertext[0]! ^ 1;
  parts[3] = ciphertext.toString('base64url');
  assert.throws(() => encryption.decrypt('mail:confirm_email', 'record-1', {
    ...envelope, ciphertext: parts.join('.'),
  }), { code: 'AUTH_SECRET_UNAVAILABLE' });
});

test('key rotation decrypts only explicitly retained keys and fails without exposing content', () => {
  const oldKey = Buffer.alloc(32, 17);
  const newKey = Buffer.alloc(32, 23);
  const original = new AuthEncryption('old', new Map([['old', oldKey]]));
  const envelope = original.encrypt('oauth_pkce', 'record', 'verifier');
  const rotated = new AuthEncryption('new', new Map([['old', oldKey], ['new', newKey], ['alias', oldKey]]));
  assert.equal(rotated.decrypt('oauth_pkce', 'record', envelope), 'verifier');
  assert.equal(rotated.encrypt('oauth_pkce', 'record', 'verifier').keyId, 'new');
  assert.throws(() => rotated.decrypt('oauth_pkce', 'record', { ...envelope, keyId: 'alias' }), { statusCode: 503 });
  const retired = new AuthEncryption('new', new Map([['new', newKey]]));
  assert.throws(() => retired.decrypt('oauth_pkce', 'record', envelope), {
    statusCode: 503, message: 'Authentication secret unavailable',
  });
  for (const ciphertext of ['v2.invalid', 'v1....', 'v1.AA.AA.AA', 'x'.repeat(100_000)]) {
    assert.throws(() => rotated.decrypt('oauth_pkce', 'record', { keyId: 'new', ciphertext }), { statusCode: 503 });
  }
  assert.throws(() => original.encrypt('oauth_pkce', 'record', 'x'.repeat(65_537)), { statusCode: 503 });
});

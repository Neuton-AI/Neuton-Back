import './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { createGoogleOidc, readGoogleConfig } from '../src/modules/identity/google-oidc.js';

const settings = {
  APP_ORIGIN: 'https://app.example.test',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://app.example.test/api/v1/auth/google/callback',
  GOOGLE_OAUTH_FLOW_KEY: Buffer.alloc(32, 1).toString('base64url'),
};
const issuer = 'https://accounts.google.com';
const proof = { state: 'test-state', nonce: 'test-nonce', verifier: 'v'.repeat(43) };

test('Google requires complete settings and the exact same-origin callback', () => {
  assert.ok(readGoogleConfig(settings));
  assert.ok(readGoogleConfig({ ...settings, SESSION_ORIGIN: settings.APP_ORIGIN }));
  assert.equal(readGoogleConfig({ ...settings, APP_ORIGIN: undefined }), null);
  assert.equal(readGoogleConfig({ ...settings, SESSION_ORIGIN: 'https://other.example.test' }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_CLIENT_SECRET: undefined }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: undefined }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: 'invalid' }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_REDIRECT_URI: `${settings.GOOGLE_REDIRECT_URI}?next=/` }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_REDIRECT_URI: 'https://other.example.test/api/v1/auth/google/callback' }), null);
});

test('Google accepts a 32-byte flow key encoded in hex or unpadded Base64url', () => {
  const bytes = Buffer.alloc(32, 0xab);
  const hex = bytes.toString('hex');
  assert.deepEqual(
    readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: hex.toUpperCase() })?.flowKey,
    bytes,
  );
  assert.deepEqual(readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: bytes.toString('base64url') })?.flowKey, bytes);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: hex.slice(2) }), null);
  assert.equal(readGoogleConfig({ ...settings, GOOGLE_OAUTH_FLOW_KEY: hex.slice(2) + 'gg' }), null);
});

test('Google authorization requests account selection with the configured callback and S256 proof', () => {
  const adapter = createGoogleOidc(readGoogleConfig(settings)!);
  const url = new URL(adapter.authorizationUrl(proof));
  assert.equal(url.origin + url.pathname, `${issuer}/o/oauth2/v2/auth`);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: settings.GOOGLE_CLIENT_ID,
    redirect_uri: settings.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state: proof.state,
    nonce: proof.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(proof.verifier).digest('base64url'),
  });
});

test('Google exchange checks the actual token signature, claims and PKCE exchange', async (t) => {
  const info = t.mock.method(OAuth2Client.log, 'info', () => {});
  const error = t.mock.method(OAuth2Client.log, 'error', () => {});
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: settings.GOOGLE_CLIENT_ID, iat: now, exp: now + 3600,
    sub: 'google-subject', nonce: proof.nonce, email: 'Example@example.test', email_verified: true, name: 'Test User' };
  function token(payload: Record<string, unknown>, privateKey = key.privateKey, alg = 'RS256') {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signed = `${encode({ alg, kid: 'test-key' })}.${encode(payload)}`;
    return `${signed}.${sign('sha256', Buffer.from(signed), privateKey).toString('base64url')}`;
  }

  let idToken = token(claims);
  let tokenStatus = 200;
  let certificateStatus = 200;
  let tokenRequests = 0;
  const adapter = createGoogleOidc(readGoogleConfig(settings)!, async (input, init) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'), settings.GOOGLE_CLIENT_SECRET);
      assert.equal(body.get('redirect_uri'), settings.GOOGLE_REDIRECT_URI);
      assert.equal(body.get('grant_type'), 'authorization_code');
      if (body.get('code_verifier') !== proof.verifier || body.get('code') !== 'test-code') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (tokenStatus === 401) return Response.json({ error: 'invalid_client' }, { status: tokenStatus });
      return Response.json({ id_token: idToken, access_token: 'unused-token' }, { status: tokenStatus });
    }
    assert.equal(url.href, 'https://www.googleapis.com/oauth2/v1/certs');
    return Response.json({ 'test-key': key.publicKey.export({ type: 'spki', format: 'pem' }) }, { status: certificateStatus });
  });
  const exchange = () => adapter.exchange('test-code', proof);
  assert.deepEqual(await exchange(), {
    issuer, subject: claims.sub, email: claims.email, emailVerified: true, name: claims.name,
  });
  idToken = token({ ...claims, iss: 'accounts.google.com', email: undefined, email_verified: 'true' });
  assert.deepEqual(await exchange(), { issuer, subject: claims.sub, email: undefined, emailVerified: false, name: claims.name });

  for (const invalid of [
    token(claims, otherKey.privateKey), token(claims, key.privateKey, 'none'),
    token({ ...claims, iss: `${issuer}/` }), token({ ...claims, aud: 'other-client' }),
    token({ ...claims, exp: now - 1 }), token({ ...claims, nonce: 'different' }), token({ ...claims, sub: '' }),
    token({ ...claims, azp: 'other-client' }), '',
  ]) {
    idToken = invalid;
    await assert.rejects(exchange(), { code: 'GOOGLE_PROOF_INVALID', message: 'Google sign-in could not be verified' });
  }
  idToken = token({ ...claims, nonce: undefined });
  await assert.rejects(adapter.exchange('test-code', { ...proof, nonce: undefined! }), { code: 'GOOGLE_PROOF_INVALID' });
  await assert.rejects(adapter.exchange('test-code', { ...proof, verifier: 'x'.repeat(43) }), { code: 'GOOGLE_PROOF_INVALID' });
  tokenStatus = 401;
  await assert.rejects(exchange(), { code: 'SERVICE_UNAVAILABLE' });
  tokenStatus = 503;
  const requestsBeforeOutage = tokenRequests;
  await assert.rejects(exchange(), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(tokenRequests, requestsBeforeOutage + 1);
  tokenStatus = 200;
  idToken = token(claims);
  certificateStatus = 503;
  await assert.rejects(exchange(), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(info.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

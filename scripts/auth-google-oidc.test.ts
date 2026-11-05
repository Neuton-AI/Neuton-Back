import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import * as oidc from 'openid-client';
import { GoogleProtocolClient } from '../src/modules/auth/google-oidc.client.js';
import { syntheticAuthConfig } from './support/authConfig.js';

test('Google adapter uses PKCE and validates signed identity and fresh authentication', async () => {
  const config = syntheticAuthConfig().google;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  let claims: Record<string, unknown> = { iss: 'https://accounts.google.com', sub: 'stable-subject',
    aud: config.clientId, exp: now + 300, iat: now, nonce: 'nonce', email: 'person@example.com', email_verified: true };
  let invalidSignature = false;
  const fetcher: oidc.CustomFetch = async (url, options) => {
    if (String(url).includes('.well-known')) {
      return Response.json({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token', jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
    }
    if (String(url).endsWith('/certs')) return Response.json({ keys: [jwk] });
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(new URLSearchParams(String(options?.body)).get('code_verifier'), 'verifier');
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    let signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
    if (invalidSignature) signature = Buffer.alloc(signature.length);
    return Response.json({ access_token: 'discard-me', token_type: 'Bearer', id_token: `${header}.${payload}.${signature.toString('base64url')}` });
  };
  const client = new GoogleProtocolClient(config, { [oidc.customFetch]: fetcher });
  const start = new URL(await client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge', purpose: 'login' }));
  assert.equal(start.searchParams.get('scope'), 'openid email profile');
  assert.equal(start.searchParams.get('response_type'), 'code');
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(start.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(start.searchParams.has('access_type'), false);
  const input = { callbackUrl: new URL(`${config.redirectUri}?code=code&state=state`), state: 'state', nonce: 'nonce', verifier: 'verifier', purpose: 'login' as const };
  assert.equal((await client.exchange(input)).subject, 'stable-subject');
  invalidSignature = true;
  await assert.rejects(client.exchange(input), { code: 'GOOGLE_AUTH_FAILED' });
  invalidSignature = false;
  for (const invalid of [{ nonce: 'wrong' }, { aud: 'other-client' }, { azp: 'other-client' }, { exp: now - 3600 }, { iss: 'https://attacker.example' }]) {
    const previous = claims;
    claims = { ...claims, ...invalid };
    await assert.rejects(client.exchange(input), { code: 'GOOGLE_AUTH_FAILED' });
    claims = previous;
  }
  await assert.rejects(client.exchange({ ...input, state: 'wrong' }), { code: 'GOOGLE_AUTH_FAILED' });
  const fresh = new URL(await client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge: 'challenge', purpose: 'reauthenticate' }));
  assert.equal(fresh.searchParams.get('max_age'), '0');
  assert.equal(fresh.searchParams.get('prompt'), 'login');
  await assert.rejects(client.exchange({ ...input, purpose: 'reauthenticate' }), { code: 'GOOGLE_AUTH_FAILED' });
  claims.auth_time = now;
  assert.ok((await client.exchange({ ...input, purpose: 'reauthenticate' })).authenticatedAt);
  claims.auth_time = now - 3600;
  await assert.rejects(client.exchange({ ...input, purpose: 'reauthenticate' }), { code: 'GOOGLE_AUTH_FAILED' });
});

import * as oidc from 'openid-client';
import type { ApiAuthConfig } from '../../config/auth.js';
import { AppError } from '../../lib/errors.js';
import { GoogleOidcClient } from './auth.ports.js';
import type { GoogleIdentityClaims, GooglePurpose } from './auth.ports.js';
import { authUnavailable } from './auth-errors.js';

const ISSUER = 'https://accounts.google.com';
const failed = () => new AppError(400, 'GOOGLE_AUTH_FAILED', 'Google authentication failed; start again');
function protocolError(error: unknown): AppError {
  if (error instanceof AppError && error.statusCode === 503) return error;
  if (error instanceof oidc.ClientError && error.code === 'OAUTH_TIMEOUT') return authUnavailable();
  return failed();
}

/** Google supplies identity proof only; account and session decisions stay in Neuton. */
export class GoogleProtocolClient extends GoogleOidcClient {
  private configuration?: Promise<oidc.Configuration>;

  constructor(private readonly google: ApiAuthConfig['google'], private readonly options: oidc.DiscoveryRequestOptions = {}) { super(); }

  private discover(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc.discovery(new URL(ISSUER), this.google.clientId,
        { client_secret: this.google.clientSecret, id_token_signed_response_alg: 'RS256' }, undefined,
        { ...this.options, execute: [oidc.enableNonRepudiationChecks], timeout: 10 }).catch(() => {
          this.configuration = undefined;
          throw authUnavailable();
        });
    }
    return this.configuration;
  }

  async authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; purpose: GooglePurpose }): Promise<string> {
    try {
      const parameters: Record<string, string> = { redirect_uri: this.google.redirectUri, scope: 'openid email profile',
        response_type: 'code', state: input.state, nonce: input.nonce,
        code_challenge: input.codeChallenge, code_challenge_method: 'S256' };
      if (input.purpose === 'reauthenticate') {
        parameters.max_age = '0';
        parameters.prompt = 'select_account';
        parameters.claims = JSON.stringify({ id_token: { auth_time: { essential: true } } });
      }
      return oidc.buildAuthorizationUrl(await this.discover(), parameters).href;
    } catch (error) { throw protocolError(error); }
  }

  async exchange(input: { callbackUrl: URL; state: string; nonce: string; verifier: string; purpose: GooglePurpose }): Promise<GoogleIdentityClaims> {
    try {
      const callback = new URL(input.callbackUrl);
      callback.search = '';
      callback.hash = '';
      if (callback.href !== this.google.redirectUri) throw failed();
      const checks: oidc.AuthorizationCodeGrantChecks = { expectedState: input.state, expectedNonce: input.nonce,
        pkceCodeVerifier: input.verifier, idTokenExpected: true };
      if (input.purpose === 'reauthenticate') checks.maxAge = 0;
      const tokens = await oidc.authorizationCodeGrant(await this.discover(), input.callbackUrl, checks);
      const claims = tokens.claims();
      if (!claims || claims.iss !== ISSUER || !claims.sub || claims.sub.length > 255 ||
        (claims.azp !== undefined && claims.azp !== this.google.clientId)) {
        throw failed();
      }
      let authenticatedAt: Date | null = null;
      if (input.purpose === 'reauthenticate') {
        if (typeof claims.auth_time !== 'number' || claims.auth_time > Date.now() / 1000 + 60) throw failed();
        authenticatedAt = new Date(claims.auth_time * 1000);
      }
      return { issuer: ISSUER, subject: claims.sub,
        observedEmail: typeof claims.email === 'string' ? claims.email : null,
        emailVerified: claims.email_verified === true,
        displayName: typeof claims.name === 'string' ? claims.name.slice(0, 200) : null,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture.slice(0, 2048) : null, authenticatedAt };
    } catch (error) { throw protocolError(error); }
  }
}

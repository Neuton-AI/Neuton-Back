import { createHash } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { decodeProtectedHeader } from 'jose';
import type { Env } from '../../env.js';
import { AppError } from '../../lib/errors.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_CALLBACK_PATH = '/api/v1/auth/google/callback';
export const GOOGLE_OIDC = Symbol('GOOGLE_OIDC');
const acceptedIssuers = [GOOGLE_ISSUER, 'accounts.google.com'];

type GoogleSettings = Pick<Env, 'APP_ORIGIN' | 'SESSION_ORIGIN' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
  | 'GOOGLE_REDIRECT_URI' | 'GOOGLE_OAUTH_FLOW_KEY'>;

type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string; flowKey: Buffer };
type GoogleProof = { nonce: string; verifier: string };

export type GoogleIdentity = {
  issuer: typeof GOOGLE_ISSUER;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
};

export interface GoogleOidc {
  authorizationUrl(attempt: GoogleProof & { state: string }): string;
  exchange(code: string, attempt: GoogleProof): Promise<GoogleIdentity>;
}

export function readGoogleConfig(settings: GoogleSettings): GoogleConfig | null {
  const { APP_ORIGIN: origin, SESSION_ORIGIN: legacyOrigin, GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri, GOOGLE_OAUTH_FLOW_KEY: encodedKey } = settings;
  if (legacyOrigin && legacyOrigin !== origin) return null;
  if (!clientId || !clientSecret || !origin || redirectUri !== `${origin}${GOOGLE_CALLBACK_PATH}` || !encodedKey) {
    return null;
  }
  const flowKey = Buffer.from(encodedKey, 'base64url');
  if (flowKey.length !== 32 || flowKey.toString('base64url') !== encodedKey) return null;
  return { clientId, clientSecret, redirectUri, flowKey };
}

const invalidProof = () => new AppError(400, 'GOOGLE_PROOF_INVALID', 'Google sign-in could not be verified');
const providerUnavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', 'Google sign-in is temporarily unavailable');

function rejectedAuthorizationCode(error: unknown) {
  if (!(error instanceof Error) || !('status' in error) || error.status !== 400 || !('response' in error)) return false;
  const response = error.response;
  if (!response || typeof response !== 'object' || !('data' in response)) return false;
  const data = response.data;
  return Boolean(data && typeof data === 'object' && 'error' in data && data.error === 'invalid_grant');
}

export function createGoogleOidc(config: Pick<GoogleConfig, 'clientId' | 'clientSecret' | 'redirectUri'>,
  fetchImplementation?: typeof fetch): GoogleOidc {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    issuers: acceptedIssuers,
    // The library's default interceptors can log token response bodies.
    useAuthRequestParameters: false,
    transporterOptions: { fetchImplementation, timeout: 5_000, redirect: 'error', retryConfig: { retry: 0 } },
  });

  return {
    authorizationUrl({ state, nonce, verifier }) {
      const options = {
        scope: 'openid email profile', state, nonce,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      };
      return client.generateAuthUrl(options);
    },
    async exchange(code, { nonce, verifier }) {
      if (!code || !nonce || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalidProof();
      let idToken: unknown;
      try {
        const { tokens } = await client.getToken({ code, codeVerifier: verifier });
        idToken = tokens?.id_token;
      } catch (error) {
        if (rejectedAuthorizationCode(error)) throw invalidProof();
        throw providerUnavailable();
      }
      if (typeof idToken !== 'string' || !idToken) throw invalidProof();
      let algorithm: string | undefined;
      try {
        algorithm = decodeProtectedHeader(idToken).alg;
      } catch {
        throw invalidProof();
      }
      if (algorithm !== 'RS256') throw invalidProof();

      const { certs } = await client.getFederatedSignonCerts().catch(() => { throw providerUnavailable(); });
      const ticket = await client.verifySignedJwtWithCertsAsync(idToken, certs, config.clientId, acceptedIssuers)
        .catch(() => { throw invalidProof(); });
      const claims = ticket.getPayload();
      if (!claims || claims.nonce !== nonce || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000
        || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
        || (claims.azp !== undefined && claims.azp !== config.clientId)) {
        throw invalidProof();
      }
      return {
        issuer: GOOGLE_ISSUER,
        subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : undefined,
      };
    },
  };
}

import type { AuthDatabaseTransaction } from '../../db/auth-client.js';

export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>;
  abstract verify(encodedHash: string, password: string): Promise<boolean>;
}

export type GooglePurpose = 'login' | 'link' | 'reauthenticate';
export interface GoogleIdentityClaims {
  issuer: 'https://accounts.google.com';
  subject: string;
  observedEmail: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  authenticatedAt: Date | null;
}

export abstract class GoogleOidcClient {
  abstract authorizationUrl(input: {
    state: string; nonce: string; codeChallenge: string; purpose: GooglePurpose;
  }): Promise<string>;
  abstract exchange(input: {
    callbackUrl: URL; state: string; nonce: string; verifier: string; purpose: GooglePurpose;
  }): Promise<GoogleIdentityClaims>;
}

export interface AuthMailMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
}

export abstract class AuthMailer {
  abstract send(message: AuthMailMessage): Promise<void>;
}

/** Only the private auth connection implements this port. No default app pool. */
export abstract class AuthPersistence {
  abstract transaction<T>(work: (transaction: AuthDatabaseTransaction) => Promise<T>): Promise<T>;
}

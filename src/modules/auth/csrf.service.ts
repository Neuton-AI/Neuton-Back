import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { forbidden } from '../../lib/errors.js';
import { AuthRepository, authRows } from './auth.repository.js';
import { AuthCookies } from './cookies.js';
import type { BrowserConfig } from './cookies.js';
import { digestSecret, newSecret, secretMatches } from './crypto.js';
import { isBearerSecret } from './normalization.js';

export type BrowserHeaders = Record<string, string | string[] | undefined>;
export interface CsrfSessions {
  csrfContext(secret: string): Promise<{ csrfDigest: string; id: string } | null>;
  rotateCsrf(secret: string, digest: string): Promise<{ expiresAt: Date } | null>;
}

export function assertBrowserMutation(headers: BrowserHeaders, origin: string, bootstrap = false): void {
  const contentType = headers['content-type'];
  const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim().toLowerCase() : undefined;
  if (headers.origin !== origin || !['application/json', 'multipart/form-data'].includes(mediaType ?? '')) throw forbidden('Invalid browser request');
  const site = headers['sec-fetch-site'];
  if ((site !== undefined && site !== 'same-origin') || (bootstrap && site !== 'same-origin')) throw forbidden('Invalid browser request');
  const mode = headers['sec-fetch-mode'];
  if (mode !== undefined && mode !== 'cors' && mode !== 'same-origin') throw forbidden('Invalid browser request');
}

export class CsrfService {
  readonly cookies: AuthCookies;
  constructor(private readonly auth: AuthRepository, private readonly sessions: CsrfSessions, private readonly config: BrowserConfig) {
    this.cookies = new AuthCookies(config);
  }

  async bootstrap(headers: BrowserHeaders): Promise<{ csrfToken: string; cookies: string[] }> {
    assertBrowserMutation(headers, this.config.origin, true);
    const csrfToken = newSecret();
    const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : undefined;
    const sessionSecret = this.cookies.read('session', cookieHeader);
    const cookies: string[] = [];
    if (sessionSecret) {
      const session = await this.sessions.rotateCsrf(sessionSecret, digestSecret('csrf', csrfToken));
      if (session) return { csrfToken, cookies };
      cookies.push(this.cookies.clear('session'));
    }
    let browserSecret = this.cookies.read('browser', cookieHeader);
    const browser = await this.auth.transaction(async transaction => {
      if (browserSecret) {
        const [current] = await authRows(transaction, sql`update auth_private.browser_contexts set csrf_digest=${digestSecret('csrf', csrfToken)}
          where token_digest=${digestSecret('browser_context', browserSecret)} and environment=${this.config.environment}
          and expires_at>clock_timestamp() returning expires_at as "expiresAt"`, z.object({ expiresAt: z.coerce.date() }));
        if (current) return current;
      }
      browserSecret = newSecret();
      const [created] = await authRows(transaction, sql`insert into auth_private.browser_contexts(id,token_digest,csrf_digest,environment,expires_at)
        values(${randomUUID()}::uuid,${digestSecret('browser_context', browserSecret)},${digestSecret('csrf', csrfToken)},${this.config.environment},
        clock_timestamp()+${AUTH_POLICY.tokens.browserContextMs}*interval '1 millisecond') returning expires_at as "expiresAt"`,
      z.object({ expiresAt: z.coerce.date() }));
      if (!created) throw new Error('Browser context not created');
      return created;
    });
    cookies.push(this.cookies.set('browser', browserSecret!, browser.expiresAt));
    return { csrfToken, cookies };
  }

  async verify(headers: BrowserHeaders): Promise<void> {
    assertBrowserMutation(headers, this.config.origin);
    const token = headers['x-csrf-token'];
    if (typeof token !== 'string' || !isBearerSecret(token)) throw forbidden('Invalid CSRF proof');
    const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : undefined;
    const sessionSecret = this.cookies.read('session', cookieHeader);
    if (sessionSecret) {
      const session = await this.sessions.csrfContext(sessionSecret);
      if (!session || !secretMatches('csrf', token, session.csrfDigest)) throw forbidden('Invalid CSRF proof');
      return;
    }
    const browserSecret = this.cookies.read('browser', cookieHeader);
    if (!browserSecret) throw forbidden('Invalid CSRF proof');
    const [browser] = await this.auth.transaction(transaction => authRows(transaction, sql`select csrf_digest as digest
      from auth_private.browser_contexts where token_digest=${digestSecret('browser_context', browserSecret)}
      and environment=${this.config.environment} and expires_at>clock_timestamp()`, z.object({ digest: z.string() })));
    if (!browser || !secretMatches('csrf', token, browser.digest)) throw forbidden('Invalid CSRF proof');
  }
}

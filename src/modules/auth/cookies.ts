import { parseCookie, stringifySetCookie } from 'cookie';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { isBearerSecret } from './normalization.js';

type CookieKind = 'session' | 'browser';
export interface BrowserConfig { origin: string; environment: string; localHttp: boolean }

export class AuthCookies {
  constructor(private readonly config: BrowserConfig) {
    if (config.localHttp && (!config.environment.startsWith('development:') && !config.environment.startsWith('test:'))) {
      throw new Error('HTTP auth cookies require an explicit development environment');
    }
    const url = new URL(config.origin);
    if (config.localHttp && (url.protocol !== 'http:' || url.hostname !== 'localhost')) throw new Error('Localhost origin required');
    if (!config.localHttp && url.protocol !== 'https:') throw new Error('HTTPS origin required');
  }

  name(kind: CookieKind): string {
    const suffix = kind === 'session' ? 'session' : 'browser';
    return this.config.localHttp ? `neuton-dev-${suffix}` : `__Host-neuton-${suffix}`;
  }

  read(kind: CookieKind, header: string | undefined): string | undefined {
    if (!header || header.length > 8192) return undefined;
    const name = this.name(kind);
    const occurrences = header.split(';').filter(part => part.trim().split('=', 1)[0] === name).length;
    if (occurrences !== 1) return undefined;
    const value = parseCookie(header)[name];
    return value && isBearerSecret(value) ? value : undefined;
  }

  set(kind: CookieKind, secret: string, expiresAt: Date): string {
    if (!isBearerSecret(secret)) throw new Error('Valid cookie secret required');
    const lifetime = kind === 'session' ? AUTH_POLICY.session.idleMs : AUTH_POLICY.tokens.browserContextMs;
    return this.serialize(kind, secret, new Date(Math.min(expiresAt.getTime(), Date.now() + lifetime)));
  }

  clear(kind: CookieKind): string { return this.serialize(kind, '', new Date(0)); }

  private serialize(kind: CookieKind, value: string, expires: Date): string {
    return stringifySetCookie({ name: this.name(kind), value, expires, path: '/', secure: !this.config.localHttp,
      httpOnly: true, sameSite: 'lax', maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)) });
  }
}

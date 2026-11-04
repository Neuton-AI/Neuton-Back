import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { IdentityRepository, SessionVerifier } from './identity.ports.js';
import { DrizzleIdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { ShopGuard } from './shop.guard.js';
import { SessionGuard } from './session.guard.js';
import { CookieSessionVerifier } from './cookie-session-verifier.js';
import { SessionRepository } from '../auth/session.repository.js';
import { AuthCookies, AUTH_BROWSER_CONFIG } from '../auth/cookies.js';
import type { BrowserConfig } from '../auth/cookies.js';
import { readBrowserConfig } from '../../config/auth.js';
import { authUnavailable } from '../auth/auth-errors.js';

const defaultProviders: Provider[] = [
  {
    provide: IdentityRepository,
    useFactory: async () => new DrizzleIdentityRepository((await import('../../db/client.js')).db),
  },
  {
    provide: SessionVerifier,
    useFactory: (sessions?: SessionRepository) => new CookieSessionVerifier(sessions ?? { async resolve() { throw authUnavailable(); } }),
    inject: [{ token: SessionRepository, optional: true }],
  },
  { provide: AuthCookies, useFactory: (config?: BrowserConfig) => new AuthCookies(config ?? readBrowserConfig()),
    inject: [{ token: AUTH_BROWSER_CONFIG, optional: true }] },
];

@Module({ providers: [...defaultProviders, IdentityService, ShopGuard, SessionGuard], exports: [IdentityService, ShopGuard, SessionGuard] })
export class IdentityModule {
  /** Replace external collaborators without replacing the guard or use case. */
  static register(options: { sessionVerifier: SessionVerifier; repository: IdentityRepository }): DynamicModule {
    return {
      module: IdentityModule,
      providers: [
        { provide: SessionVerifier, useValue: options.sessionVerifier },
        { provide: IdentityRepository, useValue: options.repository },
      ],
    };
  }
}

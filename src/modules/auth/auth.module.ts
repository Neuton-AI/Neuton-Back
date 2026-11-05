import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { ApiAuthConfig } from '../../config/auth.js';
import { createAuthDatabase } from '../../db/auth-client.js';
import type { Logger } from '../../lib/logger/types.js';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { ActionTokenRepository } from './action-token.repository.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { SmtpAuthMailer } from './auth-mailer.js';
import { MailDispatcher } from './mail-dispatcher.js';
import { SecurityEvents } from './security-events.js';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module.js';
import { createAuthServices } from './auth-services.js';
import type { AuthServices } from './auth-services.js';
import type { SessionApplicationDatabase } from './session-projection.js';
import { SessionProjection } from './session-projection.js';
import { SessionRepository } from './session.repository.js';
import { SessionService } from './session.service.js';
import { CsrfService } from './csrf.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { CsrfController } from './csrf.controller.js';
import { AuthController } from './auth.controller.js';
import { GoogleController } from './google.controller.js';
import { GoogleLoginService } from './google-login.service.js';
import { MethodsController } from './methods.controller.js';
import { MethodsService } from './methods.service.js';
import { SessionController } from './session.controller.js';
import { AccountService } from './account.service.js';
import { PasswordService } from './password.service.js';
import { AuthCookies, AUTH_BROWSER_CONFIG } from './cookies.js';
import { AuthRateLimits, RedisAuthLimitStore } from './rate-limit.service.js';
import { AuthRateLimitGuard } from './rate-limit.guard.js';
export const AUTH_SERVICES = Symbol('AUTH_SERVICES');

/** API-owned resources. Workers never import this module or obtain the auth connection. */
export class AuthRuntime implements OnModuleInit, OnModuleDestroy {
  readonly services: AuthServices;
  private readonly database;
  private readonly mailer: SmtpAuthMailer;
  private readonly dispatcher: MailDispatcher;
  private readonly limitsStore: RedisAuthLimitStore;

  constructor(config: ApiAuthConfig, log: Logger, redisUrl: string, application: SessionApplicationDatabase) {
    this.database = createAuthDatabase({ AUTH_DATABASE_URL: config.databases.auth });
    const auth = new AuthRepository(this.database.database);
    this.limitsStore = new RedisAuthLimitStore(redisUrl);
    const limits = new AuthRateLimits(this.limitsStore, config.encryption.rateLimitSecret, config.environment, config.redisNamespace);
    this.services = createAuthServices(config, auth, application, limits);
    this.mailer = new SmtpAuthMailer(config.smtp, config.origin);
    this.dispatcher = new MailDispatcher(this.services.outbox, this.mailer, log);
  }

  onModuleInit(): void { this.dispatcher.start(); }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.dispatcher.stop();
    } finally {
      try { this.mailer.close(); }
      finally { this.limitsStore.close(); await this.database.close(); }
    }
  }
}

@Module({})
export class AuthModule {
  /** Composition supplies validated process configuration; importing this file reads no environment. */
  static forRoot(config: () => ApiAuthConfig, log: Logger, redisUrl: string, application: SessionApplicationDatabase): DynamicModule {
    return this.forServices(() => {
      const runtime = new AuthRuntime(config(), log, redisUrl, application);
      return { ...runtime.services, onModuleInit: () => runtime.onModuleInit(), onModuleDestroy: () => runtime.onModuleDestroy() };
    });
  }

  static forServices(services: AuthServices | (() => AuthServices)): DynamicModule {
    return { global: true, module: AuthModule, imports: [IdentityModule], controllers: [AuthController, CsrfController, SessionController, GoogleController, MethodsController], providers: [
      { provide: AUTH_SERVICES, useFactory: () => typeof services === 'function' ? services() : services },
      { provide: AuthRepository, useFactory: (s: AuthServices) => s.auth, inject: [AUTH_SERVICES] },
      { provide: AccountRepository, useFactory: (s: AuthServices) => s.accounts, inject: [AUTH_SERVICES] },
      { provide: ActionTokenRepository, useFactory: (s: AuthServices) => s.actions, inject: [AUTH_SERVICES] },
      { provide: SessionRepository, useFactory: (s: AuthServices) => s.sessions, inject: [AUTH_SERVICES] },
      { provide: SessionService, useFactory: (s: AuthServices) => s.sessionService, inject: [AUTH_SERVICES] },
      { provide: SessionProjection, useFactory: (s: AuthServices) => s.projection, inject: [AUTH_SERVICES] },
      { provide: AccountService, useFactory: (s: AuthServices) => s.accountService, inject: [AUTH_SERVICES] },
      { provide: PasswordService, useFactory: (s: AuthServices) => s.passwords, inject: [AUTH_SERVICES] },
      { provide: GoogleLoginService, useFactory: (s: AuthServices) => s.google, inject: [AUTH_SERVICES] },
      { provide: MethodsService, useFactory: (s: AuthServices) => s.methods, inject: [AUTH_SERVICES] },
      { provide: MailOutboxRepository, useFactory: (s: AuthServices) => s.outbox, inject: [AUTH_SERVICES] },
      { provide: CsrfService, useFactory: (s: AuthServices) => s.csrf, inject: [AUTH_SERVICES] },
      { provide: AuthCookies, useFactory: (s: AuthServices) => s.csrf.cookies, inject: [AUTH_SERVICES] },
      { provide: AUTH_BROWSER_CONFIG, useFactory: (s: AuthServices) => s.config, inject: [AUTH_SERVICES] },
      { provide: AuthRateLimits, useFactory: (s: AuthServices) => s.limits, inject: [AUTH_SERVICES] },
      { provide: SecurityEvents, useFactory: (s: AuthServices) => s.events, inject: [AUTH_SERVICES] },
      CsrfGuard, AuthRateLimitGuard, { provide: APP_GUARD, useExisting: CsrfGuard },
    ], exports: [AuthRepository, AccountRepository, ActionTokenRepository, SessionRepository, SessionService, PasswordService,
      AuthCookies, AUTH_BROWSER_CONFIG, MailOutboxRepository, SecurityEvents] };
  }
}

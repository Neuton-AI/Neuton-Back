import { Module } from '@nestjs/common';
import type { DynamicModule, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { ApiAuthConfig } from '../../config/auth.js';
import { createAuthDatabase } from '../../db/auth-client.js';
import type { Logger } from '../../lib/logger/types.js';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { ActionTokenRepository } from './action-token.repository.js';
import { AuthEncryption } from './crypto.js';
import { MailTemplates } from './mail-templates.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { SmtpAuthMailer } from './auth-mailer.js';
import { MailDispatcher } from './mail-dispatcher.js';
import { SecurityEvents } from './security-events.js';

/** API-owned resources. Workers never import this module or obtain the auth connection. */
export class AuthRuntime implements OnModuleInit, OnModuleDestroy {
  readonly auth: AuthRepository;
  readonly outbox: MailOutboxRepository;
  private readonly database;
  private readonly mailer: SmtpAuthMailer;
  private readonly dispatcher: MailDispatcher;

  constructor(config: ApiAuthConfig, log: Logger) {
    this.database = createAuthDatabase({ AUTH_DATABASE_URL: config.databases.auth });
    this.auth = new AuthRepository(this.database.database);
    this.outbox = new MailOutboxRepository(this.auth, new AuthEncryption(config.encryption.activeKeyId, config.encryption.keys),
      new MailTemplates(config.origin));
    this.mailer = new SmtpAuthMailer(config.smtp, config.origin);
    this.dispatcher = new MailDispatcher(this.outbox, this.mailer, log);
  }

  onModuleInit(): void { this.dispatcher.start(); }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.dispatcher.stop();
    } finally {
      try { this.mailer.close(); }
      finally { await this.database.close(); }
    }
  }
}

@Module({})
export class AuthModule {
  /** Composition supplies validated process configuration; importing this file reads no environment. */
  static forRoot(config: ApiAuthConfig, log: Logger): DynamicModule {
    return { module: AuthModule, providers: [
      { provide: AuthRuntime, useFactory: () => new AuthRuntime(config, log) },
      { provide: AuthRepository, useFactory: (runtime: AuthRuntime) => runtime.auth, inject: [AuthRuntime] },
      { provide: MailOutboxRepository, useFactory: (runtime: AuthRuntime) => runtime.outbox, inject: [AuthRuntime] },
      { provide: AccountRepository, useFactory: (auth: AuthRepository) => new AccountRepository(auth), inject: [AuthRepository] },
      { provide: ActionTokenRepository, useFactory: (auth: AuthRepository) => new ActionTokenRepository(auth), inject: [AuthRepository] },
      SecurityEvents,
    ], exports: [AuthRepository, AccountRepository, ActionTokenRepository, MailOutboxRepository, SecurityEvents] };
  }
}

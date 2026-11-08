import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { IdentityRepository, SessionVerifier } from './identity.ports.js';
import { DrizzleIdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { ShopGuard } from './shop.guard.js';
import { SessionGuard } from './session.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';

const defaultProviders: Provider[] = [
  {
    provide: IdentityRepository,
    useFactory: async () => new DrizzleIdentityRepository((await import('../../db/client.js')).db),
  },
  {
    provide: SessionService,
    useFactory: async () => new SessionService((await import('../../db/client.js')).db),
  },
  {
    provide: SessionVerifier,
    inject: [SessionService],
    useFactory: (sessions: SessionService): SessionVerifier => ({
      async verify(secret) {
        const session = await sessions.resolve(secret);
        return session && { id: session.userId, email: session.email, session };
      },
    }),
  },
  {
    provide: AuthService,
    inject: [SessionService],
    useFactory: async (sessions: SessionService) => new AuthService((await import('../../db/client.js')).db, sessions),
  },
];

@Module({
  controllers: [AuthController],
  providers: [...defaultProviders, IdentityService, ShopGuard, SessionGuard],
  exports: [AuthService, IdentityService, ShopGuard, SessionGuard],
})
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

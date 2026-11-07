import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { IdentityRepository, SessionVerifier } from './identity.ports.js';
import { DrizzleIdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { ShopGuard } from './shop.guard.js';
import { SessionGuard } from './session.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { NeutonJwt } from './neuton-jwt.js';

const defaultProviders: Provider[] = [
  {
    provide: IdentityRepository,
    useFactory: async () => new DrizzleIdentityRepository((await import('../../db/client.js')).db),
  },
  {
    provide: NeutonJwt,
    useFactory: async () => new NeutonJwt(Buffer.from((await import('../../env.js')).env.NEUTON_JWT_SECRET, 'hex')),
  },
  { provide: SessionVerifier, useExisting: NeutonJwt },
  {
    provide: AuthService,
    inject: [NeutonJwt],
    useFactory: async (jwt: NeutonJwt) => new AuthService((await import('../../db/client.js')).db, jwt),
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

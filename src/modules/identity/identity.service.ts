import { Inject, Injectable } from '@nestjs/common';
import { SHOP_ROLES } from '../../db/schema/enums.js';
import {
  AppError,
  badRequest,
  forbidden,
  unauthorized,
} from '../../lib/errors.js';
import type { ActorContext } from './contracts.js';
import { IdentityRepository, SessionVerifier } from './identity.ports.js';
import type { Request } from 'express';
import { protectSessionMutation, requireMatchingSession, sessionSecret } from './session-http.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(SessionVerifier) private readonly sessions: SessionVerifier,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
  ) {}

  private async verifySession(request: Request) {
    const secret = sessionSecret(request);
    if (!secret) throw unauthorized('Missing session cookie');
    const session = await this.sessions.verify(secret);
    if (!session) throw unauthorized('Invalid or expired session');
    if (session.session) {
      requireMatchingSession(request, session.session.id);
      protectSessionMutation(request, secret);
    }
    return session;
  }

  async authenticate(request: Request) {
    const session = await this.verifySession(request);
    const profile = await this.repository.findProfile(session.id);
    return {
      session: session.session,
      user: { id: session.id, email: session.email, fullName: profile?.fullName ?? null, avatarUrl: profile?.avatarUrl ?? null },
    };
  }

  async resolve(input: {
    request: Request;
    shopId?: string;
  }): Promise<Pick<ActorContext, 'user' | 'shop' | 'role'>> {
    const session = await this.verifySession(input.request);

    const requestedShopId = input.shopId;
    if (typeof requestedShopId !== 'string' || !requestedShopId.trim()) {
      throw new AppError(
        400,
        'MISSING_SHOP_ID',
        'Missing required header: x-shop-id',
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestedShopId,
      )
    ) {
      throw badRequest('Invalid header: x-shop-id must be a UUID');
    }
    const membership = await this.repository.findMembership(
      session.id,
      requestedShopId,
    );
    if (
      !membership ||
      membership.shopId !== requestedShopId ||
      !SHOP_ROLES.includes(membership.role)
    ) {
      throw forbidden('You do not have access to the requested shop');
    }
    const shop = await this.repository.findShop(membership.shopId);
    if (!shop || shop.id !== requestedShopId) throw forbidden('Shop not found');
    const profile = await this.repository.findProfile(session.id);
    return {
      user: {
        id: session.id,
        email: session.email,
        fullName: profile?.fullName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      },
      shop,
      role: membership.role,
    };
  }
}

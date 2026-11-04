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
import { AuthCookies } from '../auth/cookies.js';
import { referenceVerifiedSession } from './verified-session.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(SessionVerifier) private readonly sessions: SessionVerifier,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
    @Inject(AuthCookies) private readonly cookies: AuthCookies,
  ) {}

  private async verifySession(cookie?: string) {
    const token = this.cookies.read('session', cookie);
    if (!token) throw unauthorized();
    const session = await this.sessions.verify(token);
    if (!session) throw unauthorized('Invalid or expired session');
    if (session.status !== 'active') throw forbidden('Confirm your email before accessing shop data');
    return session;
  }

  async authenticate(cookie?: string): Promise<Pick<ActorContext, 'user' | 'session' | 'sessionId'>> {
    const session = await this.verifySession(cookie);
    const reference = referenceVerifiedSession(session.id, session.sessionId);
    const profile = await this.repository.findProfile(session.id, reference);
    return {
      session: reference, sessionId: session.sessionId,
      user: {
        id: session.id,
        email: session.email,
        fullName: profile?.fullName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      },
    };
  }

  async resolve(input: {
    cookie?: string;
    shopId?: string;
  }): Promise<Pick<ActorContext, 'user' | 'shop' | 'role' | 'session' | 'sessionId'>> {
    const session = await this.verifySession(input.cookie);
    const reference = referenceVerifiedSession(session.id, session.sessionId);

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
      reference,
    );
    if (
      !membership ||
      membership.shopId !== requestedShopId ||
      !SHOP_ROLES.includes(membership.role)
    ) {
      throw forbidden('You do not have access to the requested shop');
    }
    const shop = await this.repository.findShop(membership.shopId, reference);
    if (!shop || shop.id !== requestedShopId) throw forbidden('Shop not found');
    const profile = await this.repository.findProfile(session.id, reference);
    return {
      session: reference, sessionId: session.sessionId,
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

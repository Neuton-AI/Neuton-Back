import { Inject, Injectable } from '@nestjs/common';
import { SHOP_ROLES } from '../../db/schema/enums.js';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import type { ActorContext } from './contracts.js';
import { IdentityRepository, SessionVerifier } from './identity.ports.js';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(SessionVerifier) private readonly sessions: SessionVerifier,
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
  ) {}

  async resolve(input: { authorization?: string; shopId?: string }): Promise<Pick<ActorContext, 'user' | 'shop' | 'role'>> {
    const authorization = input.authorization;
    const token = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : undefined;
    if (!token) throw unauthorized('Missing bearer token');
    const session = await this.sessions.verify(token);
    if (!session) throw unauthorized('Invalid or expired session');

    const requestedShopId = input.shopId;
    if (typeof requestedShopId !== 'string' || !requestedShopId.trim()) {
      throw new AppError(400, 'MISSING_SHOP_ID', 'Missing required header: x-shop-id');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedShopId)) {
      throw badRequest('Invalid header: x-shop-id must be a UUID');
    }
    const membership = await this.repository.findMembership(session.id, requestedShopId);
    if (!membership || membership.shopId !== requestedShopId || !SHOP_ROLES.includes(membership.role)) {
      throw forbidden('You do not have access to the requested shop');
    }
    const shop = await this.repository.findShop(membership.shopId);
    if (!shop || shop.id !== requestedShopId) throw forbidden('Shop not found');
    const profile = await this.repository.findProfile(session.id);
    return {
      user: { id: session.id, email: session.email, fullName: profile?.fullName ?? null, avatarUrl: profile?.avatarUrl ?? null },
      shop,
      role: membership.role,
    };
  }
}

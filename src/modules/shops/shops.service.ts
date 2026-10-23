import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
import type { ActorContext } from '../identity/contracts.js';
import type { SessionActor } from '../identity/session.guard.js';
import { requireActorRole } from '../identity/authorization.js';
import { ShopsPersistence } from './shops.persistence.js';
import { PasswordService } from './password.service.js';
import type {
  createShopSchema,
  shopSettingsSchema,
  updateProfileSchema,
  passwordSchema,
} from './contracts.js';
import { recordAudit, type AuditEvent } from '../../lib/audit.js';
import { toNumber } from '../../lib/money.js';
export const SHOPS_AUDIT = Symbol('SHOPS_AUDIT');
@Injectable()
export class ShopsService {
  constructor(
    @Inject(ShopsPersistence) private readonly persistence: ShopsPersistence,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Optional()
    @Inject(SHOPS_AUDIT)
    private readonly writeAudit: typeof recordAudit = recordAudit,
  ) {}
  async session(actor: SessionActor) {
    return {
      user: actor.user,
      memberships: await this.persistence.memberships(actor.user.id),
    };
  }
  private async audit(
    actor: SessionActor,
    shopId: string,
    eventType: AuditEvent,
    metadata: Record<string, unknown>,
  ) {
    try {
      await this.writeAudit({
        shopId,
        userId: actor.user.id,
        eventType,
        resourceId: shopId,
        ipAddress: actor.ipAddress,
        metadata,
      });
    } catch {
      actor.log.error(
        { event: 'shop_audit_failed', eventType },
        'audit write failed',
      );
    }
    actor.log.info(
      { event: eventType.toLowerCase(), shopId },
      'shop operation committed',
    );
  }
  async create(actor: SessionActor, body: z.infer<typeof createShopSchema>) {
    const shop = await this.persistence.create(actor.user, body);
    await this.audit(actor, shop.id, 'SHOP_CREATED', { slug: shop.slug });
    return { shop };
  }
  async find(actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { shop: await this.persistence.find(actor.shop.id) };
  }
  async update(actor: ActorContext, body: z.infer<typeof shopSettingsSchema>) {
    requireActorRole(actor, ['owner', 'admin']);
    const shop = await this.persistence.update(actor.shop, body);
    await this.audit(actor, shop.id, 'SHOP_UPDATED', {
      fields: Object.keys(body),
    });
    return { shop };
  }
  async profile(actor: SessionActor) {
    return {
      profile: await this.persistence.profile(actor.user.id),
      email: actor.user.email,
    };
  }
  async updateProfile(
    actor: SessionActor,
    body: z.infer<typeof updateProfileSchema>,
  ) {
    return {
      profile: await this.persistence.updateProfile(actor.user.id, body),
    };
  }
  password(actor: SessionActor, body: z.infer<typeof passwordSchema>) {
    return this.passwords.change(actor.user, body);
  }
  delivery(actor: ActorContext, distanceKm: number) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const base = toNumber(actor.shop.deliveryBaseFee),
      rate = toNumber(actor.shop.deliveryRatePerKm);
    return {
      distanceKm,
      baseFee: base,
      ratePerKm: rate,
      deliveryFee: Math.round((base + distanceKm * rate) * 100) / 100,
    };
  }
}

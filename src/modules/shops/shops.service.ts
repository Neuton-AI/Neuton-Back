import { Inject, Injectable } from '@nestjs/common';
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
import type { AuditEvent } from '../../lib/audit.js';
import { toNumber } from '../../lib/money.js';
@Injectable()
export class ShopsService {
  constructor(
    @Inject(ShopsPersistence) private readonly persistence: ShopsPersistence,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}
  private async audit(
    actor: SessionActor,
    shopId: string,
    eventType: AuditEvent,
    metadata: Record<string, unknown>,
  ) {
    actor.log.info(
      { event: eventType.toLowerCase(), shopId, ...metadata },
      'shop operation committed',
    );
  }
  async create(actor: SessionActor, body: z.infer<typeof createShopSchema>) {
    const shop = await this.persistence.create(actor, body);
    await this.audit(actor, shop.id, 'SHOP_CREATED', { slug: shop.slug });
    return { shop };
  }
  async find(actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { shop: await this.persistence.find(actor) };
  }
  async update(actor: ActorContext, body: z.infer<typeof shopSettingsSchema>) {
    requireActorRole(actor, ['owner', 'admin']);
    const shop = await this.persistence.update(actor, body);
    await this.audit(actor, shop.id, 'SHOP_UPDATED', {
      fields: Object.keys(body),
    });
    return { shop };
  }
  async profile(actor: SessionActor) {
    return {
      profile: await this.persistence.profile(actor),
      email: actor.user.email,
    };
  }
  async updateProfile(
    actor: SessionActor,
    body: z.infer<typeof updateProfileSchema>,
  ) {
    return {
      profile: await this.persistence.updateProfile(actor, body),
    };
  }
  password(actor: SessionActor, body: z.infer<typeof passwordSchema>) {
    return this.passwords.change(actor, body);
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

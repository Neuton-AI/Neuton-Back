import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { AnalyticsPersistence, type Period } from './analytics.persistence.js';
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(AnalyticsPersistence)
    private readonly persistence: AnalyticsPersistence,
  ) {}
  dashboard(actor: ActorContext, period: Period) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, (persistence, currentActor) => {
      requireActorRole(currentActor, ['owner', 'admin', 'member']);
      return persistence.dashboard(currentActor.shop.id, period);
    });
  }
  recent(actor: ActorContext, limit: number) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, (persistence, currentActor) => persistence.recent(currentActor.shop.id, limit));
  }
  inventoryValue(actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, (persistence, currentActor) => persistence.inventoryValue(currentActor.shop.id));
  }
}

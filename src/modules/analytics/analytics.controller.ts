import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { AnalyticsService } from './analytics.service.js';
import { dashboardSchema, recentSchema } from './contracts.js';
@Controller('api/v1/analytics')
@UseGuards(ShopGuard)
export class AnalyticsController {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}
  @Get('dashboard') dashboard(
    @CurrentActor() actor: ActorContext,
    @Query() query: unknown,
  ) {
    return this.analytics.dashboard(actor, dashboardSchema.parse(query).period);
  }
  @Get('recent-orders') recent(
    @CurrentActor() actor: ActorContext,
    @Query() query: unknown,
  ) {
    return this.analytics.recent(actor, recentSchema.parse(query).limit);
  }
  @Get('inventory-value') inventory(@CurrentActor() actor: ActorContext) {
    return this.analytics.inventoryValue(actor);
  }
}

import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { CatalogService } from './catalog.service.js';
import { inventoryQuerySchema } from './contracts.js';

@Controller('api/v1')
@UseGuards(ShopGuard)
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(@CurrentActor() actor: ActorContext) {
    return this.catalog.categories(actor);
  }

  @Get('inventory')
  inventory(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.catalog.inventory(actor, inventoryQuerySchema.parse(query));
  }
}

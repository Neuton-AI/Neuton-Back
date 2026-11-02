import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { createCategorySchema } from './contracts.js';
import { CategoriesService } from './categories.service.js';
@Controller('api/v1')
@UseGuards(ShopGuard)
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly categoriesService: CategoriesService) {}


  @Get('categories')
  categories(@CurrentActor() actor: ActorContext) {
    return this.categoriesService.categories(actor);
  }

  @Post('categories')
  createCategory(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.categoriesService.createCategory(actor, createCategorySchema.parse(body));
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { CatalogService } from './catalog.service.js';
import { createCategorySchema, inventoryQuerySchema, recipeQuerySchema, recipeIdSchema, recipeSchema, recipePatchSchema, verifyRecipeSchema } from './contracts.js';

@Controller('api/v1')
@UseGuards(ShopGuard)
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('categories')
  categories(@CurrentActor() actor: ActorContext) {
    return this.catalog.categories(actor);
  }

  @Post('categories')
  createCategory(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.catalog.createCategory(actor, createCategorySchema.parse(body));
  }

  @Get('inventory')
  inventory(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.catalog.inventory(actor, inventoryQuerySchema.parse(query));
  }

  @Get('recipes')
  recipes(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.catalog.recipes(actor, recipeQuerySchema.parse(query));
  }

  @Post('recipes')
  createRecipe(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.catalog.createRecipe(actor, recipeSchema.parse(body));
  }

  @Get('recipes/orderable')
  orderable(@CurrentActor() actor: ActorContext) {
    return this.catalog.orderable(actor);
  }

  @Get('recipes/:id')
  recipe(@CurrentActor() actor: ActorContext, @Param() params: unknown) {
    return this.catalog.recipe(actor, recipeIdSchema.parse(params).id);
  }

  @Patch('recipes/:id')
  editRecipe(@CurrentActor() actor: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    return this.catalog.editRecipe(actor, recipeIdSchema.parse(params).id, recipePatchSchema.parse(body));
  }

  @Post('recipes/:id/verify')
  @HttpCode(200)
  verifyRecipe(@CurrentActor() actor: ActorContext, @Param() params: unknown, @Body() body: unknown) {
    return this.catalog.verifyRecipe(actor, recipeIdSchema.parse(params).id, verifyRecipeSchema.parse(body));
  }
}

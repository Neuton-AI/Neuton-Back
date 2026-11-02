import { Req, Res, Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { syncMutation, sendMutation } from '../../http/sync-mutation.js';
import { SyncService } from '../sync/sync.service.js';
import { manualProductSchema } from '../../lib/manualProduct.js';
import { barcodePriceSchema, recipeQuerySchema, recipeIdSchema, recipeSchema, recipePatchSchema, verifyRecipeSchema } from './contracts.js';
import { RecipeService } from './recipe.service.js';
@Controller('api/v1')
@UseGuards(ShopGuard)
export class RecipeController {
  constructor(
    @Inject(RecipeService) private readonly recipeService: RecipeService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}


  @Delete('recipes/:id')
  async deleteRecipe(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = recipeIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'recipe', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.recipeService.inTransaction(tx, afterCommit)
            : this.recipeService;
        return service.deleteRecipe(actor, id);
      },
    );
    return sendMutation(response, result);
  }
  @Post('recipes/:id/manual-product')
  manualProduct(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.recipeService.manualProduct(
      actor,
      recipeIdSchema.parse(params).id,
      manualProductSchema.parse(body),
    );
  }
  @Post('recipes/:id/barcode-price')
  @HttpCode(200)
  barcodePrice(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.recipeService.barcodePrice(
      actor,
      recipeIdSchema.parse(params).id,
      barcodePriceSchema.parse(body),
    );
  }

  @Get('recipes')
  recipes(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.recipeService.recipes(actor, recipeQuerySchema.parse(query));
  }

  @Post('recipes')
  createRecipe(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.recipeService.createRecipe(actor, recipeSchema.parse(body));
  }

  @Get('recipes/orderable')
  orderable(@CurrentActor() actor: ActorContext) {
    return this.recipeService.orderable(actor);
  }

  @Get('recipes/:id')
  recipe(@CurrentActor() actor: ActorContext, @Param() params: unknown, @Req() request: HttpRequest) {
    const id = recipeIdSchema.parse(params).id;
    const read = () => this.recipeService.recipe(actor, id);
    return request.headers['x-sync-snapshot'] === 'true' ? this.sync.snapshot(actor, 'recipe', id, read) : read();
  }

  @Patch('recipes/:id')
  async editRecipe(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = recipeIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'recipe', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.recipeService.inTransaction(tx, afterCommit)
            : this.recipeService;
        return service.editRecipe(actor, id, recipePatchSchema.parse(body));
      },
    );
    return sendMutation(response, result);
  }

  @Post('recipes/:id/verify')
  @HttpCode(200)
  async verifyRecipe(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = recipeIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'recipe', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.recipeService.inTransaction(tx, afterCommit)
            : this.recipeService;
        return service.verifyRecipe(actor, id, verifyRecipeSchema.parse(body));
      },
    );
    return sendMutation(response, result);
  }
}

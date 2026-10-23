import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { syncMutation, sendMutation } from '../../http/sync-mutation.js';
import { SyncService } from '../sync/sync.service.js';
import {
  Req,
  Res,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { manualProductSchema } from '../../lib/manualProduct.js';
import { inventoryAdjustmentSchema } from '../../lib/inventoryAdjustments.js';
import {
  inventorySchema,
  inventoryPatchSchema,
  barcodePriceSchema,
} from './contracts.js';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { CatalogService } from './catalog.service.js';
import {
  createCategorySchema,
  inventoryQuerySchema,
  recipeQuerySchema,
  recipeIdSchema,
  recipeSchema,
  recipePatchSchema,
  verifyRecipeSchema,
} from './contracts.js';

@Controller('api/v1')
@UseGuards(ShopGuard)
export class CatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
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
            ? this.catalog.inTransaction(tx, afterCommit)
            : this.catalog;
        return service.deleteRecipe(actor, id);
      },
    );
    return sendMutation(response, result);
  }

  @Post('inventory')
  createInventory(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.catalog.createInventory(actor, inventorySchema.parse(body));
  }
  @Post('inventory/adjust')
  @HttpCode(200)
  adjust(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.catalog.adjustInventory(
      actor,
      inventoryAdjustmentSchema.parse(body),
      z.string().uuid().optional().parse(key),
    );
  }
  @Patch('inventory/:id')
  editInventory(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.catalog.editInventory(
      actor,
      recipeIdSchema.parse(params).id,
      inventoryPatchSchema.parse(body),
    );
  }
  @Delete('inventory/:id')
  deactivateInventory(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
  ) {
    return this.catalog.deactivateInventory(
      actor,
      recipeIdSchema.parse(params).id,
    );
  }
  @Post('recipes/:id/manual-product')
  manualProduct(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.catalog.manualProduct(
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
    return this.catalog.barcodePrice(
      actor,
      recipeIdSchema.parse(params).id,
      barcodePriceSchema.parse(body),
    );
  }

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
            ? this.catalog.inTransaction(tx, afterCommit)
            : this.catalog;
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
            ? this.catalog.inTransaction(tx, afterCommit)
            : this.catalog;
        return service.verifyRecipe(actor, id, verifyRecipeSchema.parse(body));
      },
    );
    return sendMutation(response, result);
  }
}

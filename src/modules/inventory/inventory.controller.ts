import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { z } from 'zod';
import { inventoryAdjustmentSchema } from '../../lib/inventoryAdjustments.js';
import { inventorySchema, inventoryPatchSchema, inventoryQuerySchema, inventoryIdSchema } from './contracts.js';
import { InventoryService } from './inventory.service.js';
@Controller('api/v1')
@UseGuards(ShopGuard)
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventoryService: InventoryService) {}


  @Post('inventory')
  createInventory(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.inventoryService.createInventory(actor, inventorySchema.parse(body));
  }
  @Post('inventory/adjust')
  @HttpCode(200)
  adjust(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    return this.inventoryService.adjustInventory(
      actor,
      inventoryAdjustmentSchema.parse(body),
      z.string().uuid().parse(key),
    );
  }
  @Patch('inventory/:id')
  editInventory(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.inventoryService.editInventory(
      actor,
      inventoryIdSchema.parse(params).id,
      inventoryPatchSchema.parse(body),
    );
  }
  @Delete('inventory/:id')
  deactivateInventory(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
  ) {
    return this.inventoryService.deactivateInventory(
      actor,
      inventoryIdSchema.parse(params).id,
    );
  }

  @Get('inventory')
  inventory(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.inventoryService.inventory(actor, inventoryQuerySchema.parse(query));
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { OrdersService } from './orders.service.js';
import { createOrderSchema, listOrdersSchema, orderIdSchema, quoteOrderSchema } from './contracts.js';
@Controller('api/v1/orders')
@UseGuards(ShopGuard)
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  list(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.orders.list(actor, listOrdersSchema.parse(query));
  }

  @Get(':id')
  detail(@CurrentActor() actor: ActorContext, @Param() params: unknown) {
    return this.orders.detail(actor, orderIdSchema.parse(params).id);
  }

  @Post('quote')
  @HttpCode(200)
  quote(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.orders.quote(actor, quoteOrderSchema.parse(body));
  }

  @Post()
  @HttpCode(201)
  create(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.orders.create(actor, createOrderSchema.parse(body));
  }

  @Post(':id/verify')
  @HttpCode(200)
  verify(@CurrentActor() actor: ActorContext, @Param() params: unknown) {
    return this.orders.verify(actor, orderIdSchema.parse(params).id);
  }

  @Delete(':id')
  cancel(@CurrentActor() actor: ActorContext, @Param() params: unknown) {
    return this.orders.cancel(actor, orderIdSchema.parse(params).id);
  }
}

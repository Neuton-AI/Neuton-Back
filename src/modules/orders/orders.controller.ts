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
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { OrdersService } from './orders.service.js';
import {
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  quoteOrderSchema,
} from './contracts.js';
@Controller('api/v1/orders')
@UseGuards(ShopGuard)
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

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
  async create(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = null;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'order', id, 201),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.orders.inTransaction(tx, afterCommit)
            : this.orders;
        return service.create(actor, createOrderSchema.parse(body));
      },
    );
    return sendMutation(response, result);
  }

  @Post(':id/verify')
  @HttpCode(200)
  async verify(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      {
        ...syncMutation(request, 'order', id, 200),
        allowedRoles: ['owner', 'admin', 'member'],
      },
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.orders.inTransaction(tx, afterCommit)
            : this.orders;
        return service.verify(actor, id);
      },
    );
    return sendMutation(response, result);
  }

  @Delete(':id')
  async cancel(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'order', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.orders.inTransaction(tx, afterCommit)
            : this.orders;
        return service.cancel(actor, id);
      },
    );
    return sendMutation(response, result);
  }
}

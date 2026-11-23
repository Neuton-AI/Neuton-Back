import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { syncMutation, sendMutation } from '../../http/sync-mutation.js';
import { SyncService } from '../sync/sync.service.js';
import { syncVersionSchema } from '../sync/contracts.js';
import { conflict } from '../../lib/errors.js';
import { z } from 'zod';
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
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import { requireActorRole } from '../identity/authorization.js';
import type { ActorContext } from '../identity/contracts.js';
import { OrdersService } from './orders.service.js';
import {
  cancelOrderSchema,
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  recordPaymentSchema,
  undoDeliverySchema,
  updateOrderSchema,
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
  detail(@CurrentActor() actor: ActorContext, @Param() params: unknown, @Req() request: HttpRequest) {
    const id = orderIdSchema.parse(params).id;
    const read = () => this.orders.detail(actor, id);
    return request.headers['x-sync-snapshot'] === 'true' ? this.sync.snapshot(actor, 'order', id, read) : read();
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    let reportedLegacyContract = false;
    const id = null;
    const result = await this.sync.mutate(
      actor,
      { ...syncMutation(request, 'order', id, 201), transactionIsolation: 'serializable' },
      async (tx, afterCommit) => {
        const input = createOrderSchema.parse(body);
        if (!reportedLegacyContract && (
          input.deliveryDate === undefined || input.deliveryFee === undefined ||
          input.items.some(item => item.expectedUnitPrice === undefined)
        )) {
          request.log.info({ event: 'legacy_order_create_contract' }, 'Legacy order create contract used');
          reportedLegacyContract = true;
        }
        const service =
          tx && afterCommit
            ? this.orders.inTransaction(tx, afterCommit)
            : this.orders;
        return service.create(actor, input);
      },
    );
    return sendMutation(response, result);
  }

  @Patch(':id')
  async edit(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const mutation = syncMutation(request, 'order', id);
    const mutationId = z.string().uuid().parse(mutation.mutationId);
    const version = syncVersionSchema.parse(mutation.version);
    const baseVersion = syncVersionSchema.parse(mutation.baseVersion);
    const input = updateOrderSchema.parse(body);
    const result = await this.sync.mutate(
      actor,
      { ...mutation, mutationId, version, baseVersion, transactionIsolation: 'serializable' },
      async (tx, afterCommit) => {
        if (!tx || !afterCommit) throw new Error('Order edit requires a sync transaction');
        const detail = await this.orders.inTransaction(tx, afterCommit).edit(actor, id, input);
        return { ...detail, syncVersion: version };
      },
    );
    if (typeof result.body === 'object' && result.body && 'syncConflict' in result.body) {
      throw conflict('This order changed. Reopen it before saving your changes.');
    }
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

  @Post(':id/undo-delivery')
  @HttpCode(200)
  async undoDelivery(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const mutation = syncMutation(request, 'order', id);
    const mutationId = z.string().uuid().parse(mutation.mutationId);
    const version = syncVersionSchema.parse(mutation.version);
    const baseVersion = syncVersionSchema.parse(mutation.baseVersion);
    undoDeliverySchema.parse(body);
    const result = await this.sync.mutate(
      actor,
      { ...mutation, mutationId, version, baseVersion, requireExistingDocument: true },
      async (tx, afterCommit) => {
        if (!tx || !afterCommit) throw new Error('Undo delivery requires a sync transaction');
        const detail = await this.orders.inTransaction(tx, afterCommit).undoDelivery(actor, id);
        return { ...detail, syncVersion: version };
      },
    );
    if (typeof result.body === 'object' && result.body && 'syncConflict' in result.body) {
      throw conflict('This order changed. Reopen it before undoing delivery.');
    }
    return sendMutation(response, result);
  }

  @Post(':id/payments')
  @HttpCode(200)
  async recordPayment(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const mutation = syncMutation(request, 'order', id);
    const mutationId = z.string().uuid().parse(mutation.mutationId);
    const version = syncVersionSchema.parse(mutation.version);
    const baseVersion = syncVersionSchema.parse(mutation.baseVersion);
    const input = recordPaymentSchema.parse(body);
    const result = await this.sync.mutate(
      actor,
      { ...mutation, mutationId, version, baseVersion, requireExistingDocument: true },
      async (tx, afterCommit) => {
        if (!tx || !afterCommit) throw new Error('Recording a payment requires a sync transaction');
        const detail = await this.orders.inTransaction(tx, afterCommit).recordPayment(actor, id, input);
        return { ...detail, syncVersion: version };
      },
    );
    if (typeof result.body === 'object' && result.body && 'syncConflict' in result.body) {
      throw conflict('This order changed. Reopen it before recording a payment.');
    }
    return sendMutation(response, result);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = orderIdSchema.parse(params).id;
    const mutation = syncMutation(request, 'order', id);
    const mutationId = z.string().uuid().parse(mutation.mutationId);
    const version = syncVersionSchema.parse(mutation.version);
    const baseVersion = syncVersionSchema.parse(mutation.baseVersion);
    const decision = cancelOrderSchema.parse(body);
    const result = await this.sync.mutate(
      actor,
      { ...mutation, mutationId, version, baseVersion, requireExistingDocument: true },
      async (tx, afterCommit) => {
        if (!tx || !afterCommit) throw new Error('Order cancellation requires a sync transaction');
        const result = await this.orders.inTransaction(tx, afterCommit).cancel(actor, id, decision);
        if (result.outcome === 'deleted') return result;
        return { ...result, syncVersion: version };
      },
    );
    if (typeof result.body === 'object' && result.body && 'syncConflict' in result.body) {
      throw conflict('This order changed. Reload it before canceling.');
    }
    return sendMutation(response, result);
  }

  @Delete(':id')
  legacyCancel(@CurrentActor() actor: ActorContext, @Param() params: unknown) {
    orderIdSchema.parse(params);
    requireActorRole(actor, ['owner', 'admin']);
    throw conflict('Reload the app and use Cancel from the order details.');
  }
}

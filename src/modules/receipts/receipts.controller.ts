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
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { ReceiptsService } from './receipts.service.js';
import {
  receiptIdSchema,
  receiptQuerySchema,
  receiptPatchSchema,
  verifySchema,
} from './contracts.js';
@Controller('api/v1/receipts')
@UseGuards(ShopGuard)
export class ReceiptsController {
  constructor(
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}
  @Get() list(@CurrentActor() actor: ActorContext, @Query() query: unknown) {
    return this.receipts.list(actor, receiptQuerySchema.parse(query));
  }
  @Get('queue/pending-count') pending(@CurrentActor() actor: ActorContext) {
    return this.receipts.pending(actor);
  }
  @Get(':id/status') status(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
  ) {
    return this.receipts.status(actor, receiptIdSchema.parse(params).id);
  }
  @Get(':id') detail(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Req() request: HttpRequest,
  ) {
    const id = receiptIdSchema.parse(params).id;
    const read = () => this.receipts.detail(actor, id);
    return request.headers['x-sync-snapshot'] === 'true' ? this.sync.snapshot(actor, 'receipt', id, read) : read();
  }
  @Patch(':id') async edit(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = receiptIdSchema.parse(params).id;
    const input = receiptPatchSchema.parse(body);
    const result = await this.sync.mutate(
      actor, syncMutation(request, 'receipt', id, 200),
      async (tx, afterCommit) => {
        const service = tx && afterCommit
          ? this.receipts.inTransaction(tx, afterCommit) : this.receipts;
        return service.edit(actor, id, input);
      },
    );
    return sendMutation(response, result);
  }
  @Post(':id/verify') @HttpCode(200) async verify(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = receiptIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'receipt', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.receipts.inTransaction(tx, afterCommit)
            : this.receipts;
        return service.verify(actor, id, verifySchema.parse(body));
      },
    );
    return sendMutation(response, result);
  }
  @Delete(':id') async delete(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const id = receiptIdSchema.parse(params).id;
    const result = await this.sync.mutate(
      actor,
      syncMutation(request, 'receipt', id, 200),
      async (tx, afterCommit) => {
        const service =
          tx && afterCommit
            ? this.receipts.inTransaction(tx, afterCommit)
            : this.receipts;
        return service.delete(actor, id);
      },
    );
    return sendMutation(response, result);
  }
}

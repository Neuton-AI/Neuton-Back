import {
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
import { ReceiptsService } from './receipts.service.js';
import {
  receiptIdSchema,
  receiptQuerySchema,
  verifySchema,
} from './contracts.js';
@Controller('api/v1/receipts')
@UseGuards(ShopGuard)
export class ReceiptsController {
  constructor(
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
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
  ) {
    return this.receipts.detail(actor, receiptIdSchema.parse(params).id);
  }
  @Post(':id/verify') @HttpCode(200) verify(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.receipts.verify(
      actor,
      receiptIdSchema.parse(params).id,
      verifySchema.parse(body),
    );
  }
  @Delete(':id') delete(
    @CurrentActor() actor: ActorContext,
    @Param() params: unknown,
  ) {
    return this.receipts.delete(actor, receiptIdSchema.parse(params).id);
  }
}

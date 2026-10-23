import {
  Controller,
  Body,
  Post,
  Inject,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { SyncService } from './sync.service.js';
import { checkSchema } from './contracts.js';
@Controller('api/v1/sync')
@UseGuards(ShopGuard)
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}
  @Post('check') @HttpCode(200) check(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ) {
    return this.sync.check(actor, checkSchema.parse(body).documents);
  }
}

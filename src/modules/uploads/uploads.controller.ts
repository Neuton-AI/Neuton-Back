import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import { UploadsService } from './uploads.service.js';
import { downloadSchema } from './contracts.js';
@Controller('api/v1/uploads')
@UseGuards(ShopGuard)
export class UploadsController {
  constructor(
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}
  @Post('presign') presign(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ) {
    return this.uploads.presign(actor, body);
  }
  @Post('complete') @HttpCode(202) complete(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ) {
    return this.uploads.complete(actor, body);
  }
  @Post('download-url') @HttpCode(200) download(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ) {
    return this.uploads.download(actor, downloadSchema.parse(body).path);
  }
}

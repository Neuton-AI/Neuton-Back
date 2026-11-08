import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Patch,
  HttpCode,
  Inject,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ShopGuard } from '../identity/shop.guard.js';
import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { setSessionCookie } from '../identity/session-http.js';
import { CurrentActor } from '../identity/current-actor.js';
import type { ActorContext } from '../identity/contracts.js';
import {
  SessionGuard,
  CurrentSession,
  type SessionActor,
} from '../identity/session.guard.js';
import { ShopsService } from './shops.service.js';
import {
  createShopSchema,
  shopSettingsSchema,
  updateProfileSchema,
  passwordSchema,
  deliverySchema,
} from './contracts.js';
@Controller('api/v1')
export class ShopsController {
  constructor(@Inject(ShopsService) private readonly shops: ShopsService) {}
  @Get('session') @Header('Cache-Control', 'no-store') @UseGuards(SessionGuard) session(
    @CurrentSession() actor: SessionActor,
  ) {
    return this.shops.session(actor);
  }
  @Post('shops') @UseGuards(SessionGuard) create(
    @CurrentSession() actor: SessionActor,
    @Body() body: unknown,
  ) {
    return this.shops.create(actor, createShopSchema.parse(body));
  }
  @Get('shop') @UseGuards(ShopGuard) find(@CurrentActor() actor: ActorContext) {
    return this.shops.find(actor);
  }
  @Patch('shop') @UseGuards(ShopGuard) update(
    @CurrentActor() actor: ActorContext,
    @Body() body: unknown,
  ) {
    return this.shops.update(actor, shopSettingsSchema.parse(body));
  }
  @Get('profile') @UseGuards(SessionGuard) profile(
    @CurrentSession() actor: SessionActor,
  ) {
    return this.shops.profile(actor);
  }
  @Patch('profile') @UseGuards(SessionGuard) updateProfile(
    @CurrentSession() actor: SessionActor,
    @Body() body: unknown,
  ) {
    return this.shops.updateProfile(actor, updateProfileSchema.parse(body));
  }
  @Post('profile/password') @HttpCode(200) @UseGuards(SessionGuard) async password(
    @CurrentSession() actor: SessionActor,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { secret, session } = await this.shops.password(actor, passwordSchema.parse(body));
    setSessionCookie(response, secret, session);
    request.log.info({ event: 'session_replaced', userId: session.userId, sessionId: session.id }, 'Password changed and sessions revoked');
    return { ok: true };
  }
  @Get('shop/delivery-preview') @UseGuards(ShopGuard) delivery(
    @CurrentActor() actor: ActorContext,
    @Query() query: unknown,
  ) {
    return this.shops.delivery(actor, deliverySchema.parse(query).distanceKm);
  }
}

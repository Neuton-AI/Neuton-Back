import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  HttpCode,
  Inject,
  Query,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthCookies } from '../auth/cookies.js';
import { ShopGuard } from '../identity/shop.guard.js';
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
  constructor(@Inject(ShopsService) private readonly shops: ShopsService, @Inject(AuthCookies) private readonly cookies: AuthCookies) {}
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
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.shops.password(actor, passwordSchema.parse(body));
    response.setHeader('Set-Cookie', this.cookies.set('session', result.secret, result.expiresAt));
    return { ok: true };
  }
  @Get('shop/delivery-preview') @UseGuards(ShopGuard) delivery(
    @CurrentActor() actor: ActorContext,
    @Query() query: unknown,
  ) {
    return this.shops.delivery(actor, deliverySchema.parse(query).distanceKm);
  }
}

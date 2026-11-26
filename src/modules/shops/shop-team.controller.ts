import { Body, Controller, Get, Header, Inject, Post, UseGuards } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { CurrentActor } from '../identity/current-actor.js';
import { ShopGuard } from '../identity/shop.guard.js';
import { sendShopInvitationSchema } from './shop-team.contracts.js';
import { ShopTeamService } from './shop-team.service.js';

@Controller('api/v1/shop/team')
@UseGuards(ShopGuard)
export class ShopTeamController {
  constructor(@Inject(ShopTeamService) private readonly team: ShopTeamService) {}

  @Get('invitations')
  @Header('Cache-Control', 'no-store')
  outgoing(@CurrentActor() actor: ActorContext) {
    return this.team.outgoing(actor);
  }

  @Post('invitations')
  @Header('Cache-Control', 'no-store')
  send(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.team.send(actor, sendShopInvitationSchema.parse(body));
  }
}

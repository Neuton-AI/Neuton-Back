import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { CurrentActor } from '../identity/current-actor.js';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentSession, SessionGuard, type SessionActor } from '../identity/session.guard.js';
import { sendShopInvitationSchema, shopInvitationIdSchema } from './shop-team.contracts.js';
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

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  cancel(@CurrentActor() actor: ActorContext, @Param('invitationId') invitationId: string) {
    return this.team.cancel(actor, shopInvitationIdSchema.parse(invitationId));
  }
}

@Controller('api/v1/shop-invitations')
@UseGuards(SessionGuard)
export class ShopInvitationsController {
  constructor(@Inject(ShopTeamService) private readonly team: ShopTeamService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  incoming(@CurrentSession() actor: SessionActor) {
    return this.team.incoming(actor.user.id);
  }

  @Post(':invitationId/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  accept(@CurrentSession() actor: SessionActor, @Param('invitationId') invitationId: string) {
    return this.team.respond(actor, shopInvitationIdSchema.parse(invitationId), 'accepted');
  }

  @Post(':invitationId/decline')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  decline(@CurrentSession() actor: SessionActor, @Param('invitationId') invitationId: string) {
    return this.team.respond(actor, shopInvitationIdSchema.parse(invitationId), 'declined');
  }
}

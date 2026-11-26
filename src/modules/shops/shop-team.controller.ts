import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { CurrentActor } from '../identity/current-actor.js';
import { ShopGuard } from '../identity/shop.guard.js';
import { CurrentSession, SessionGuard, type SessionActor } from '../identity/session.guard.js';
import {
  changeShopTeamRoleSchema, readShopInvitationsSchema, searchShopAccountsSchema, sendShopInvitationSchema,
  shopInvitationIdSchema, shopTeamMembershipIdSchema,
} from './shop-team.contracts.js';
import { ShopTeamService } from './shop-team.service.js';

@Controller('api/v1/shop/team')
@UseGuards(ShopGuard)
export class ShopTeamController {
  constructor(@Inject(ShopTeamService) private readonly team: ShopTeamService) {}

  @Get('members')
  @Header('Cache-Control', 'no-store')
  roster(@CurrentActor() actor: ActorContext) {
    return this.team.roster(actor);
  }

  @Patch('members/:membershipId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  changeRole(@CurrentActor() actor: ActorContext, @Param('membershipId') membershipId: string, @Body() body: unknown) {
    const { role } = changeShopTeamRoleSchema.parse(body);
    return this.team.changeRole(actor, shopTeamMembershipIdSchema.parse(membershipId), role);
  }

  @Delete('members/:membershipId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  removeMember(@CurrentActor() actor: ActorContext, @Param('membershipId') membershipId: string) {
    return this.team.removeMember(actor, shopTeamMembershipIdSchema.parse(membershipId));
  }

  @Post('accounts/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  searchAccounts(@CurrentActor() actor: ActorContext, @Body() body: unknown) {
    return this.team.searchAccounts(actor, searchShopAccountsSchema.parse(body));
  }

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

  @Post('read')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  markRead(@CurrentSession() actor: SessionActor, @Body() body: unknown) {
    const { invitationIds } = readShopInvitationsSchema.parse(body);
    return this.team.markRead(actor.user.id, invitationIds);
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

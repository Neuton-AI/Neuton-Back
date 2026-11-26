import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { shopInvitations, shopMembers, shops, users } from '../../db/schema/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { requireActorRole } from '../identity/authorization.js';
import type { ActorContext } from '../identity/contracts.js';
import type { OutgoingShopInvitation, SendShopInvitation } from './shop-team.contracts.js';
import { SHOPS_DATABASE } from './shops.persistence.js';

const invitationColumns = {
  id: shopInvitations.id,
  recipientId: shopInvitations.recipientId,
  offeredRole: shopInvitations.offeredRole,
  createdAt: shopInvitations.createdAt,
};

function mapOutgoing(row: Omit<OutgoingShopInvitation, 'createdAt'> & { createdAt: Date }): OutgoingShopInvitation {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class ShopTeamService {
  constructor(@Inject(SHOPS_DATABASE) private readonly database: Database) {}

  async outgoing(actor: ActorContext) {
    requireActorRole(actor, ['owner']);
    const rows = await this.database.select({ ...invitationColumns, fullName: users.fullName, email: users.email })
      .from(shopInvitations)
      .innerJoin(users, eq(users.id, shopInvitations.recipientId))
      .where(and(eq(shopInvitations.shopId, actor.shop.id), eq(shopInvitations.status, 'pending')))
      .orderBy(desc(shopInvitations.createdAt), desc(shopInvitations.id));
    return { invitations: rows.map(mapOutgoing) };
  }

  async send(actor: ActorContext, input: SendShopInvitation) {
    requireActorRole(actor, ['owner']);
    const shopId = actor.shop.id;
    return this.database.transaction(async (tx) => {
      // Take the shop lock before touching any invitations, as shop deletion does.
      const [shop] = await tx.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId)).for('no key update');
      if (!shop) throw notFound('Shop not found');
      const [owner] = await tx.select({ id: shopMembers.id }).from(shopMembers)
        .where(and(eq(shopMembers.shopId, shopId), eq(shopMembers.userId, actor.user.id), eq(shopMembers.role, 'owner')))
        .for('share');
      if (!owner) throw forbidden('Only the shop owner can send invitations');

      const [recipient] = await tx.select({ fullName: users.fullName, email: users.email })
        .from(users).where(eq(users.id, input.recipientId)).for('key share');
      if (!recipient) throw notFound('Recipient account not found');
      const [membership] = await tx.select({ id: shopMembers.id }).from(shopMembers)
        .where(and(eq(shopMembers.shopId, shopId), eq(shopMembers.userId, input.recipientId)));
      if (membership) throw conflict('This account is already on the shop team');

      const [invite] = await tx.insert(shopInvitations).values({
        shopId,
        recipientId: input.recipientId,
        offeredRole: input.offeredRole,
      }).onConflictDoNothing({
        target: [shopInvitations.shopId, shopInvitations.recipientId],
        where: sql`status = 'pending'`,
      }).returning(invitationColumns);
      if (!invite) throw conflict('This account already has a pending invitation');
      return { invitation: mapOutgoing({ ...invite, ...recipient }) };
    });
  }
}

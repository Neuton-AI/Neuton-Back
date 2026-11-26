import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { shopInvitations, shopMembers, shops, users } from '../../db/schema/index.js';
import { INVITABLE_SHOP_ROLES } from '../../db/schema/shop-invitations.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { requireActorRole } from '../identity/authorization.js';
import type { ActorContext } from '../identity/contracts.js';
import type { SessionActor } from '../identity/session.guard.js';
import type { OutgoingShopInvitation, SearchShopAccounts, SendShopInvitation, ShopAccountMatch, ShopTeamRole } from './shop-team.contracts.js';
import { SHOPS_DATABASE } from './shops.persistence.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type RecipientDecision = 'accepted' | 'declined';
const accountSearchPageSize = 4;

const invitationColumns = {
  id: shopInvitations.id,
  recipientId: shopInvitations.recipientId,
  offeredRole: shopInvitations.offeredRole,
  createdAt: shopInvitations.createdAt,
};

function mapOutgoing(row: Omit<OutgoingShopInvitation, 'createdAt'> & { createdAt: Date }): OutgoingShopInvitation {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function lockShop(tx: Transaction, shopId: string) {
  // Match shop deletion's lock order. Every team write takes the shop lock first.
  return tx.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId)).for('no key update');
}

async function lockOwnedShop(tx: Transaction, actor: ActorContext) {
  const [shop] = await lockShop(tx, actor.shop.id);
  if (!shop) throw notFound('Shop not found');
  const [owner] = await tx.select({ id: shopMembers.id }).from(shopMembers)
    .where(and(eq(shopMembers.shopId, shop.id), eq(shopMembers.userId, actor.user.id), eq(shopMembers.role, 'owner')))
    .for('share');
  if (!owner) throw forbidden('Only the shop owner can manage the team');
}

async function lockManagedMember(tx: Transaction, actor: ActorContext, membershipId: string) {
  await lockOwnedShop(tx, actor);
  const [member] = await tx.select({ id: shopMembers.id, userId: shopMembers.userId, role: shopMembers.role })
    .from(shopMembers)
    .where(and(
      eq(shopMembers.id, membershipId),
      eq(shopMembers.shopId, actor.shop.id),
      inArray(shopMembers.role, [...INVITABLE_SHOP_ROLES]),
    ))
    .for('update');
  if (!member) throw notFound('Team member not found');
  return member;
}

async function resolvePending(
  tx: Transaction,
  scope: { invitationId: string; shopId: string; recipientId?: string },
  status: RecipientDecision | 'canceled',
) {
  const scopedInvite = and(
    eq(shopInvitations.id, scope.invitationId),
    eq(shopInvitations.shopId, scope.shopId),
    scope.recipientId === undefined ? undefined : eq(shopInvitations.recipientId, scope.recipientId),
  );
  const [resolved] = await tx.update(shopInvitations).set({ status, resolvedAt: sql`now()` })
    .where(and(scopedInvite, eq(shopInvitations.status, 'pending')))
    .returning({ offeredRole: shopInvitations.offeredRole });
  if (resolved) return resolved;
  const [existing] = await tx.select({ id: shopInvitations.id }).from(shopInvitations).where(scopedInvite);
  if (!existing) throw notFound('Invitation not found');
  throw conflict('This invitation is no longer pending');
}

@Injectable()
export class ShopTeamService {
  constructor(@Inject(SHOPS_DATABASE) private readonly database: Database) {}

  async roster(actor: ActorContext) {
    requireActorRole(actor, ['owner']);
    const members = await this.database.select({
      id: shopMembers.id, fullName: users.fullName, email: users.email, role: shopMembers.role,
    }).from(shopMembers)
      .innerJoin(users, eq(users.id, shopMembers.userId))
      .where(and(eq(shopMembers.shopId, actor.shop.id), inArray(shopMembers.role, [...INVITABLE_SHOP_ROLES])))
      .orderBy(shopMembers.role, users.email);
    return { members };
  }

  async changeRole(actor: ActorContext, membershipId: string, role: ShopTeamRole) {
    requireActorRole(actor, ['owner']);
    await this.database.transaction(async (tx) => {
      const member = await lockManagedMember(tx, actor, membershipId);
      if (member.role === role) return;

      await tx.update(shopMembers).set({ role }).where(eq(shopMembers.id, member.id));
      await recordAudit({
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'SHOP_MEMBER_ROLE_CHANGED',
        resourceId: member.id,
        ipAddress: actor.ipAddress,
        metadata: { memberUserId: member.userId, previousRole: member.role, role },
      }, tx);
    });
  }

  async searchAccounts(actor: ActorContext, { query, page }: SearchShopAccounts) {
    requireActorRole(actor, ['owner']);
    const shopId = actor.shop.id;
    const rows = await this.database.select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      membershipId: shopMembers.id,
      pendingId: shopInvitations.id,
      total: sql`count(*) over ()`.mapWith(Number),
    }).from(users)
      .leftJoin(shopMembers, and(eq(shopMembers.userId, users.id), eq(shopMembers.shopId, shopId)))
      .leftJoin(shopInvitations, and(
        eq(shopInvitations.recipientId, users.id), eq(shopInvitations.shopId, shopId), eq(shopInvitations.status, 'pending'),
      ))
      .where(or(
        sql`strpos(lower(${users.fullName}), lower(${query})) > 0`,
        sql`strpos(lower(${users.email}), lower(${query})) > 0`,
      ))
      .orderBy(users.email)
      .limit(accountSearchPageSize)
      .offset((page - 1) * accountSearchPageSize);

    const accounts = rows.map(({ id, fullName, email, membershipId, pendingId }): ShopAccountMatch => {
      let eligibility: ShopAccountMatch['eligibility'] = 'eligible';
      if (membershipId) eligibility = 'member';
      else if (pendingId) eligibility = 'pending';
      return { id, fullName, email, eligibility };
    });
    return { accounts, page, pageCount: Math.ceil((rows[0]?.total ?? 0) / accountSearchPageSize) };
  }

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
      await lockOwnedShop(tx, actor);

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

  async incoming(recipientId: string) {
    const rows = await this.database.select({
      id: shopInvitations.id,
      shopId: shopInvitations.shopId,
      shopName: shops.name,
      offeredRole: shopInvitations.offeredRole,
      createdAt: shopInvitations.createdAt,
      readAt: shopInvitations.readAt,
    }).from(shopInvitations)
      .innerJoin(shops, eq(shops.id, shopInvitations.shopId))
      .where(and(eq(shopInvitations.recipientId, recipientId), eq(shopInvitations.status, 'pending')))
      .orderBy(desc(shopInvitations.createdAt), desc(shopInvitations.id));
    return {
      invitations: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null })),
    };
  }

  async cancel(actor: ActorContext, invitationId: string) {
    requireActorRole(actor, ['owner']);
    await this.database.transaction(async (tx) => {
      await lockOwnedShop(tx, actor);
      await resolvePending(tx, { invitationId, shopId: actor.shop.id }, 'canceled');
    });
  }

  async markRead(recipientId: string, invitationIds: string[]) {
    await this.database.update(shopInvitations).set({ readAt: sql`now()` })
      .where(and(
        eq(shopInvitations.recipientId, recipientId),
        eq(shopInvitations.status, 'pending'),
        isNull(shopInvitations.readAt),
        inArray(shopInvitations.id, invitationIds),
      ));
  }

  async respond(actor: SessionActor, invitationId: string, decision: RecipientDecision) {
    const recipientId = actor.user.id;
    return this.database.transaction(async (tx) => {
      const [invite] = await tx.select({ shopId: shopInvitations.shopId }).from(shopInvitations)
        .where(and(eq(shopInvitations.id, invitationId), eq(shopInvitations.recipientId, recipientId)));
      if (!invite) throw notFound('Invitation not found');

      const { shopId } = invite;
      const [shop] = await lockShop(tx, shopId);
      if (!shop) throw notFound('Invitation not found');
      // Account deletion cascades to invitations. Lock the account before updating the invite.
      const [recipient] = await tx.select({ id: users.id }).from(users).where(eq(users.id, recipientId)).for('key share');
      if (!recipient) throw notFound('Invitation not found');
      const { offeredRole } = await resolvePending(tx, { invitationId, shopId, recipientId }, decision);
      if (decision === 'declined') return;

      const [membership] = await tx.insert(shopMembers).values({ shopId, userId: recipientId, role: offeredRole })
        .onConflictDoNothing({ target: [shopMembers.shopId, shopMembers.userId] })
        .returning({ id: shopMembers.id });
      if (!membership) throw conflict('This account is already on the shop team');
      await recordAudit({
        shopId,
        userId: recipientId,
        eventType: 'SHOP_INVITATION_ACCEPTED',
        resourceId: membership.id,
        ipAddress: actor.ipAddress,
        metadata: { invitationId, role: offeredRole },
      }, tx);
      return { membership: { shopId, role: offeredRole } };
    });
  }
}

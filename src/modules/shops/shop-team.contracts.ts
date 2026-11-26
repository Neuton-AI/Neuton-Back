import { z } from 'zod';
import { INVITABLE_SHOP_ROLES } from '../../db/schema/shop-invitations.js';

export const sendShopInvitationSchema = z.object({
  recipientId: z.string().uuid(),
  offeredRole: z.enum(INVITABLE_SHOP_ROLES),
}).strict();

export type SendShopInvitation = z.infer<typeof sendShopInvitationSchema>;
export const shopInvitationIdSchema = z.string().uuid();
export const shopTeamMembershipIdSchema = z.string().uuid();
export const changeShopTeamRoleSchema = z.object({
  role: z.enum(INVITABLE_SHOP_ROLES),
}).strict();
export type ShopTeamRole = z.infer<typeof changeShopTeamRoleSchema>['role'];
export const readShopInvitationsSchema = z.object({
  invitationIds: z.array(shopInvitationIdSchema).min(1).max(100),
}).strict();

export const searchShopAccountsSchema = z.object({
  query: z.string().trim().min(1).max(320).refine((query) => !query.includes('\0')),
  page: z.number().int().positive().max(1_000_000).default(1),
}).strict();

export type SearchShopAccounts = z.infer<typeof searchShopAccountsSchema>;

export interface ShopAccountMatch {
  id: string;
  fullName: string | null;
  email: string;
  eligibility: 'eligible' | 'member' | 'pending';
}

export interface OutgoingShopInvitation {
  id: string;
  recipientId: string;
  offeredRole: SendShopInvitation['offeredRole'];
  fullName: string | null;
  email: string;
  createdAt: string;
}

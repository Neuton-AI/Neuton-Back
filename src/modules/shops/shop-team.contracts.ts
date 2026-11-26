import { z } from 'zod';
import { INVITABLE_SHOP_ROLES } from '../../db/schema/shop-invitations.js';

export const sendShopInvitationSchema = z.object({
  recipientId: z.string().uuid(),
  offeredRole: z.enum(INVITABLE_SHOP_ROLES),
}).strict();

export type SendShopInvitation = z.infer<typeof sendShopInvitationSchema>;
export const shopInvitationIdSchema = z.string().uuid();

export interface OutgoingShopInvitation {
  id: string;
  recipientId: string;
  offeredRole: SendShopInvitation['offeredRole'];
  fullName: string | null;
  email: string;
  createdAt: string;
}

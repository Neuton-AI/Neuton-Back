import type { ShopContext } from '../identity/contracts.js';
import type { ShopRole } from '../../db/schema/enums.js';
import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { isBearerSecret, isValidUnicode, normalizeEmail, validatePassword } from './normalization.js';

const emailSchema = z.string().max(640).transform((value, context) => {
  try {
    return normalizeEmail(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid email address' });
    return z.NEVER;
  }
});
const passwordSchema = z.string().max(256).superRefine((value, context) => {
  try {
    validatePassword(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Password must contain 15–128 valid Unicode code points' });
  }
});
const fullNameSchema = htmlFree(z.string().max(120).trim().min(1))
  .refine(value => isValidUnicode(value) && !/[\p{Cc}\p{Cf}]/u.test(value), 'Enter a valid name');

export const registrationInput = z.object({
  email: emailSchema, password: passwordSchema, fullName: fullNameSchema.optional(),
}).strict();
export const loginInput = z.object({ email: emailSchema, password: passwordSchema }).strict();
export const emailInput = z.object({ email: emailSchema }).strict();
export const actionInput = z.object({ token: z.string().refine(isBearerSecret, 'Invalid action token') }).strict();

export interface ShopMembershipDto {
  shopId: string;
  role: ShopRole;
  shop: ShopContext;
}

export interface SessionDto {
  environment: string;
  user: {
    id: string;
    email: string;
    fullName: string | null;
    avatarUrl: string | null;
    status: 'pending_email' | 'active';
    emailConfirmedAt: string | null;
  };
  session: {
    id: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
    recentAuthenticationExpiresAt: string | null;
    renewAfter: string;
  };
  memberships: ShopMembershipDto[];
}

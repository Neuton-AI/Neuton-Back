import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
export const shopSettingsSchema = z.object({
  name: htmlFree(z.string().trim().min(2).max(120)).optional(),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(
      /^[a-z0-9-]+$/,
      'Slug may only contain lowercase letters, numbers and dashes',
    )
    .optional(),
  storeAddress: htmlFree(z.string().trim().max(300)).nullable().optional(),
  targetProfitMargin: z.coerce.number().min(0).max(999).optional(),
  hourlyLaborCost: z.coerce.number().min(0).max(100_000).optional(),
  deliveryBaseFee: z.coerce.number().min(0).max(100_000).optional(),
  deliveryRatePerKm: z.coerce.number().min(0).max(100_000).optional(),
  currency: htmlFree(z.string().trim().length(3).toUpperCase()).optional(),
  timezone: htmlFree(z.string().trim().min(1).max(80)).optional(),
});

export const createShopSchema = z.object({
  name: htmlFree(z.string().trim().min(2).max(120)),
  storeAddress: htmlFree(z.string().trim().max(300)).optional(),
  targetProfitMargin: z.coerce.number().min(0).max(999).default(35),
  hourlyLaborCost: z.coerce.number().min(0).max(100_000).default(18),
  deliveryBaseFee: z.coerce.number().min(0).max(100_000).default(3),
  deliveryRatePerKm: z.coerce.number().min(0).max(100_000).default(0.8),
});

export const updateProfileSchema = z.object({
  fullName: htmlFree(z.string().trim().min(1).max(120)).nullable().optional(),
  avatarUrl: z.string().trim().url().max(500).nullable().optional(),
});

export const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export const deliverySchema = z
  .object({ distanceKm: z.coerce.number().finite().min(0) })
  .strict();
export interface ShopDto {
  id: string;
  name: string;
  slug: string;
  lastOrderNumber: number;
  currency: string;
  timezone: string;
  storeAddress: string | null;
  targetProfitMargin: string;
  hourlyLaborCost: string;
  deliveryBaseFee: string;
  deliveryRatePerKm: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProfileDto {
  id: string;
  fullName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

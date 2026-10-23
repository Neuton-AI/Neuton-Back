import { z } from 'zod';
export const metaSchema = z.object({
  kind: z.enum(['receipt', 'recipe', 'order']),
  id: z.string().uuid(),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deleted: z.boolean().optional(),
});
export const checkSchema = z.object({
  documents: z.array(metaSchema).max(20000),
});
export const syncVersionSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export interface SyncMutation {
  allowedRoles?: readonly import('../identity/contracts.js').ShopRole[];
  mutationId: unknown;
  version: unknown;
  kind: 'receipt' | 'recipe' | 'order';
  documentId: string | null;
  method: string;
  path: string;
  body: unknown;
  status: number;
}

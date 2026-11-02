import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';


export const createCategorySchema = z.object({
  name: htmlFree(z.string().trim().min(1).max(80)),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export interface CategoryDto {
  id: string;
  shopId: string;
  name: string;
  createdAt: string;
}

import { asc, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { db } from '../../db/client.js';
import type { TransactionalDatabase } from '../../db/types.js';
import { categories } from '../../db/schema/index.js';
import type { Category } from '../../db/schema/catalog.js';
import type { CategoryDto } from './contracts.js';
export const CATEGORIES_DATABASE = Symbol('CATEGORIES_DATABASE');

function mapCategory(category: Category): CategoryDto {
  return {
    id: category.id, shopId: category.shopId, name: category.name,
    createdAt: category.createdAt.toISOString(),
  };
}
@Injectable()
export class CategoriesPersistence {
  constructor(@Inject(CATEGORIES_DATABASE) readonly database: TransactionalDatabase = db) {}

  async listCategories(shopId: string): Promise<CategoryDto[]> {
    const rows = await this.database.select().from(categories)
      .where(eq(categories.shopId, shopId)).orderBy(asc(categories.name));
    return rows.map(mapCategory);
  }

  async createCategory(shopId: string, name: string): Promise<CategoryDto> {
    const [category] = await this.database.insert(categories).values({ shopId, name }).returning();
    if (!category) throw new Error('Category insert returned no row');
    return mapCategory(category);
  }
}

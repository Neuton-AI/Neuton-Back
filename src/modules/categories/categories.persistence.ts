import { asc, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../db/client.js';
import type { ShopTransaction } from '../../db/types.js';
import type { ActorContext } from '../identity/contracts.js';
import { ShopOperation, type AfterShopCommit } from '../../db/shop-operation.js';
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
  constructor(@Inject(CATEGORIES_DATABASE) source: Database | ShopTransaction) { this.access = new ShopOperation(source); }
  private readonly access: ShopOperation;
  get database() { return this.access.database; }
  get scope() { return this.access.scope; }
  inShop<T>(actor: ActorContext, work: (persistence: CategoriesPersistence, actor: ActorContext, afterCommit?: AfterShopCommit) => Promise<T>): Promise<T> {
    return this.access.run(actor, (scope, currentActor, afterCommit) => work(new CategoriesPersistence(scope), currentActor, afterCommit));
  }

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

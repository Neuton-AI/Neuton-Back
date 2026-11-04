import type { AfterShopCommit } from '../../db/shop-operation.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import type { ShopTransaction } from '../../db/types.js';
import { CategoriesPersistence } from './categories.persistence.js';
import type { CategoryDto, CreateCategoryInput } from './contracts.js';
export const CATEGORIES_COMMIT_EFFECTS = Symbol('CATEGORIES_COMMIT_EFFECTS');
type AfterCommit = (effect: () => Promise<void>) => void;
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(CategoriesPersistence) private readonly persistence: CategoriesPersistence,
    @Optional() @Inject(CATEGORIES_COMMIT_EFFECTS) private readonly afterCommit?: AfterCommit,
  ) {}
  inTransaction(transaction: ShopTransaction, afterCommit: AfterCommit): CategoriesService {
    return new CategoriesService(new CategoriesPersistence(transaction), afterCommit);
  }
  private async committed(effect: () => Promise<void>, operationAfterCommit?: AfterShopCommit): Promise<void> {
    const defer = operationAfterCommit ?? this.afterCommit;
    if (defer) defer(effect);
    else await effect();
  }

  async createCategory(
    actor: ActorContext,
    input: CreateCategoryInput,
  ): Promise<{ category: CategoryDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin']);
      const category = await persistence.createCategory(
        actor.shop.id,
        input.name,
      );
      await this.committed(async () => {
        actor.log.info(
          { event: 'category_created', categoryId: category.id },
          'category created',
        );
      }, operationAfterCommit);
      return { category };
    });
  }

  async categories(
    actor: ActorContext,
  ): Promise<{ categories: CategoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return this.persistence.inShop(actor, async (persistence, actor, operationAfterCommit) => {
      requireActorRole(actor, ['owner', 'admin', 'member']);
      return { categories: await persistence.listCategories(actor.shop.id) };
    });
  }
}

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { toNumber } from '../../lib/money.js';
import { CatalogPersistence, type CatalogTransaction } from './catalog.persistence.js';
import { costRecipe } from './costing.js';
import { CatalogAudit } from './catalog.audit.js';
import type { CategoryDto, CreateCategoryInput, CreateRecipeInput, InventoryDto, InventoryQuery, RecipeQuery, CostedRecipeDto, RecipeDetailDto, OrderableRecipeDto, RecipeDto } from './contracts.js';

export const CATALOG_COMMIT_EFFECTS = Symbol('CATALOG_COMMIT_EFFECTS');
export type CatalogAfterCommit = (effect: () => Promise<void>) => void;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(CatalogPersistence) private readonly persistence: CatalogPersistence,
    @Inject(CatalogAudit) private readonly audit: CatalogAudit = new CatalogAudit(),
    @Optional() @Inject(CATALOG_COMMIT_EFFECTS) private readonly afterCommit?: CatalogAfterCommit,
  ) {}

  inTransaction(transaction: CatalogTransaction, afterCommit: CatalogAfterCommit): CatalogService {
    return new CatalogService(new CatalogPersistence(transaction), this.audit, afterCommit);
  }

  private async committed(effect: () => Promise<void>): Promise<void> {
    if (this.afterCommit) this.afterCommit(effect);
    else await effect();
  }

  async createCategory(actor: ActorContext, input: CreateCategoryInput): Promise<{ category: CategoryDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const category = await this.persistence.createCategory(actor.shop.id, input.name);
    await this.committed(async () => {
      actor.log.info({ event: 'category_created', categoryId: category.id }, 'category created');
    });
    return { category };
  }

  async createRecipe(actor: ActorContext, input: CreateRecipeInput): Promise<{ recipe: RecipeDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const recipe = await this.persistence.createRecipe(actor.shop.id, input);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id, userId: actor.user.id, eventType: 'RECIPE_CREATED',
        resourceId: recipe.id, ipAddress: actor.ipAddress,
      });
      actor.log.info({ event: 'recipe_created', recipeId: recipe.id }, 'recipe created');
    });
    return { recipe };
  }

  async categories(actor: ActorContext): Promise<{ categories: CategoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { categories: await this.persistence.listCategories(actor.shop.id) };
  }

  async inventory(actor: ActorContext, query: InventoryQuery): Promise<{ items: InventoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const items = await this.persistence.listInventory(actor.shop.id, query);
    return { items: items.map(item => ({
      ...item,
      isLowStock: item.reorderLevel !== null && toNumber(item.currentQuantity) <= toNumber(item.reorderLevel),
    })) };
  }

  private costing(actor: ActorContext, recipe: RecipeDto) {
    return costRecipe(actor.shop.id, recipe, actor.shop.targetProfitMargin,
      actor.shop.hourlyLaborCost, this.persistence.database);
  }

  async recipes(actor: ActorContext, query: RecipeQuery): Promise<{ recipes: CostedRecipeDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const rows = await this.persistence.listRecipes(actor.shop.id, query);
    return { recipes: await Promise.all(rows.map(async recipe => ({
      ...recipe, costing: await this.costing(actor, recipe),
    }))) };
  }

  async recipe(actor: ActorContext, id: string): Promise<{ recipe: RecipeDetailDto }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const recipe = await this.persistence.recipe(actor.shop.id, id);
    const costing = await this.costing(actor, recipe);
    const sources = await this.persistence.recipeSources(actor.shop.id, id);
    return { recipe: { ...recipe, costing, sources } };
  }

  async orderable(actor: ActorContext): Promise<{ recipes: OrderableRecipeDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const rows = await this.persistence.listRecipes(actor.shop.id, {
      includeInactive: false, includeUnverified: false,
    });
    const costed = await Promise.all(rows.map(async (recipe): Promise<OrderableRecipeDto | null> => {
      const costing = await this.costing(actor, recipe);
      if (!costing.costComplete) return null;
      return {
        id: recipe.id, name: recipe.name, imageUrl: recipe.imageUrl,
        yieldQuantity: recipe.yieldQuantity, yieldUnit: recipe.yieldUnit,
        costComplete: true, unitCost: costing.unitCost, retailPrice: costing.retailPrice,
      };
    }));
    return { recipes: costed.filter((recipe): recipe is OrderableRecipeDto => recipe !== null) };
  }
}

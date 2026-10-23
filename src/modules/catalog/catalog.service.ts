import { Inject, Injectable } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { toNumber } from '../../lib/money.js';
import { CatalogPersistence } from './catalog.persistence.js';
import { costRecipe } from './costing.js';
import type { CategoryDto, InventoryDto, InventoryQuery, RecipeQuery, CostedRecipeDto, RecipeDetailDto, OrderableRecipeDto, RecipeDto } from './contracts.js';

@Injectable()
export class CatalogService {
  constructor(@Inject(CatalogPersistence) private readonly persistence: CatalogPersistence) {}

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

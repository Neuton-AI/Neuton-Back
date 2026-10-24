import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { toNumber } from '../../lib/money.js';
import { convertEditedIngredients } from '../../lib/recipeEdits.js';
import {
  CatalogPersistence,
  type CatalogTransaction,
} from './catalog.persistence.js';
import { costRecipe } from './costing.js';
import { CatalogAudit } from './catalog.audit.js';
import { InventoryPersistence } from './inventory.persistence.js';
import { CatalogDeletionPersistence } from './catalog-deletion.persistence.js';
import {
  prepareManualProduct,
  type manualProductSchema,
} from '../../lib/manualProduct.js';
import { prepareBarcodePrice } from '../../lib/recipeBarcodePrice.js';
import { searchProduct } from '../../lib/supermarket/prices.js';
import type { inventoryAdjustmentSchema } from '../../lib/inventoryAdjustments.js';
import type { z } from 'zod';
import type {
  InventoryInput,
  InventoryPatchInput,
  BarcodePriceInput,
  BarcodePriceDto,
} from './contracts.js';
import type {
  CategoryDto,
  CreateCategoryInput,
  CreateRecipeInput,
  RecipePatchInput,
  VerifyRecipeInput,
  InventoryDto,
  InventoryQuery,
  RecipeQuery,
  CostedRecipeDto,
  RecipeDetailDto,
  OrderableRecipeDto,
  RecipeDto,
} from './contracts.js';

export const CATALOG_COMMIT_EFFECTS = Symbol('CATALOG_COMMIT_EFFECTS');
export const CATALOG_SEARCH = Symbol('CATALOG_SEARCH');
export type CatalogAfterCommit = (effect: () => Promise<void>) => void;

@Injectable()
export class CatalogService {
  constructor(
    @Inject(CatalogPersistence)
    private readonly persistence: CatalogPersistence,
    @Inject(CatalogAudit)
    private readonly audit: CatalogAudit = new CatalogAudit(),
    @Optional()
    @Inject(CATALOG_COMMIT_EFFECTS)
    private readonly afterCommit?: CatalogAfterCommit,
    @Optional()
    @Inject(CATALOG_SEARCH)
    private readonly search: typeof searchProduct = searchProduct,
  ) {}

  inTransaction(
    transaction: CatalogTransaction,
    afterCommit: CatalogAfterCommit,
  ): CatalogService {
    return new CatalogService(
      new CatalogPersistence(transaction),
      this.audit,
      afterCommit,
      this.search,
    );
  }

  private async committed(effect: () => Promise<void>): Promise<void> {
    if (this.afterCommit) this.afterCommit(effect);
    else await effect();
  }

  private get inventoryPersistence() {
    return new InventoryPersistence(this.persistence.database);
  }

  async deleteRecipe(
    actor: ActorContext,
    id: string,
  ): Promise<{ ok: true; mode: 'hard' | 'soft' }> {
    requireActorRole(actor, ['owner', 'admin']);
    const result = await new CatalogDeletionPersistence(
      this.persistence.database,
    ).delete(actor.shop.id, id, actor.traceId);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'RECIPE_DELETED',
        resourceId: id,
        ipAddress: actor.ipAddress,
        metadata: { mode: result.mode },
      });
      actor.log.info(
        { event: 'recipe_deleted', recipeId: id, mode: result.mode },
        'recipe deleted',
      );
    });
    return result;
  }

  async createInventory(actor: ActorContext, input: InventoryInput) {
    requireActorRole(actor, ['owner', 'admin']);
    const item = await this.inventoryPersistence.create(actor.shop.id, input);
    await this.inventoryAudit(actor, item.id, {
      action: 'create',
      name: input.name,
    });
    return { item };
  }
  async editInventory(
    actor: ActorContext,
    id: string,
    input: InventoryPatchInput,
  ) {
    requireActorRole(actor, ['owner', 'admin']);
    const item = await this.inventoryPersistence.edit(actor.shop.id, id, input);
    await this.inventoryAudit(actor, id);
    return { item };
  }
  async deactivateInventory(
    actor: ActorContext,
    id: string,
  ): Promise<{ ok: true }> {
    requireActorRole(actor, ['owner', 'admin']);
    await this.inventoryPersistence.deactivate(actor.shop.id, id);
    return { ok: true };
  }
  private inventoryAudit(
    actor: ActorContext,
    id: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'INVENTORY_UPDATED',
        resourceId: id,
        ipAddress: actor.ipAddress,
        metadata,
      });
      actor.log.info(
        { event: 'inventory_updated', inventoryItemId: id },
        'inventory updated',
      );
    });
  }
  async manualProduct(
    actor: ActorContext,
    id: string,
    input: z.infer<typeof manualProductSchema>,
  ) {
    requireActorRole(actor, ['owner', 'admin']);
    await this.inventoryPersistence.assertRecipe(actor.shop.id, id);
    return {
      product: await this.inventoryPersistence.manualProduct(
        prepareManualProduct(input),
      ),
      usage: convertEditedIngredients([
        { rawName: input.name, quantity: input.quantity, rawSrcUnit: input.rawSrcUnit },
      ])[0]!,
    };
  }
  async barcodePrice(
    actor: ActorContext,
    id: string,
    input: BarcodePriceInput,
  ): Promise<{ price: BarcodePriceDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    await this.inventoryPersistence.assertRecipe(actor.shop.id, id);
    const { price, quantity } = await prepareBarcodePrice(input, this.search);
    const priceId = await this.inventoryPersistence.barcodePrice(price);
    return {
      price: {
        id: priceId,
        rawName: price.rawName,
        sku: price.sku,
        rawMaterialName: price.rawMaterialName,
        rawSrcUnit: price.rawSrcUnit,
        srcUnit: price.srcUnit,
        baseUnit: price.baseUnit,
        baseUnitAmount: price.baseUnitAmount,
        baseUnitCost: price.baseUnitCost,
        quantity,
      },
    };
  }
  async adjustInventory(
    actor: ActorContext,
    input: z.infer<typeof inventoryAdjustmentSchema>,
    key: string,
  ): Promise<{ adjusted: number; ids: string[] }> {
    requireActorRole(actor, ['owner', 'admin']);
    return this.inventoryPersistence.adjust({
      shopId: actor.shop.id,
      userId: actor.user.id,
      key,
      adjustments: input.adjustments,
    });
  }

  async createCategory(
    actor: ActorContext,
    input: CreateCategoryInput,
  ): Promise<{ category: CategoryDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const category = await this.persistence.createCategory(
      actor.shop.id,
      input.name,
    );
    await this.committed(async () => {
      actor.log.info(
        { event: 'category_created', categoryId: category.id },
        'category created',
      );
    });
    return { category };
  }

  async createRecipe(
    actor: ActorContext,
    input: CreateRecipeInput,
  ): Promise<{ recipe: RecipeDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const recipe = await this.persistence.createRecipe(actor.shop.id, input);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'RECIPE_CREATED',
        resourceId: recipe.id,
        ipAddress: actor.ipAddress,
      });
      actor.log.info(
        { event: 'recipe_created', recipeId: recipe.id },
        'recipe created',
      );
    });
    return { recipe };
  }

  async editRecipe(
    actor: ActorContext,
    id: string,
    input: RecipePatchInput,
  ): Promise<{ recipe: RecipeDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const { ingredients, ...metadata } = input;
    const recipe = await this.persistence.editRecipe(
      actor.shop.id,
      id,
      metadata,
      ingredients && convertEditedIngredients(ingredients),
    );
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'RECIPE_UPDATED',
        resourceId: id,
        ipAddress: actor.ipAddress,
      });
      actor.log.info(
        { event: 'recipe_updated', recipeId: id },
        'recipe updated',
      );
    });
    return { recipe };
  }

  async verifyRecipe(
    actor: ActorContext,
    id: string,
    input: VerifyRecipeInput,
  ): Promise<{ recipe: RecipeDto }> {
    requireActorRole(actor, ['owner', 'admin']);
    const recipe = await this.persistence.verifyRecipe(
      actor.shop.id,
      id,
      input,
    );
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'RECIPE_UPDATED',
        resourceId: id,
        ipAddress: actor.ipAddress,
        metadata: { action: 'verify' },
      });
      actor.log.info(
        { event: 'recipe_verified', recipeId: id },
        'recipe verified',
      );
    });
    return { recipe };
  }

  async categories(
    actor: ActorContext,
  ): Promise<{ categories: CategoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    return { categories: await this.persistence.listCategories(actor.shop.id) };
  }

  async inventory(
    actor: ActorContext,
    query: InventoryQuery,
  ): Promise<{ items: InventoryDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const items = await this.persistence.listInventory(actor.shop.id, query);
    return {
      items: items.map((item) => ({
        ...item,
        isLowStock:
          item.reorderLevel !== null &&
          toNumber(item.currentQuantity) <= toNumber(item.reorderLevel),
      })),
    };
  }

  private costing(actor: ActorContext, recipe: RecipeDto) {
    return costRecipe(
      actor.shop.id,
      recipe,
      actor.shop.targetProfitMargin,
      actor.shop.hourlyLaborCost,
      this.persistence.database,
    );
  }

  async recipes(
    actor: ActorContext,
    query: RecipeQuery,
  ): Promise<{ recipes: CostedRecipeDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const rows = await this.persistence.listRecipes(actor.shop.id, query);
    return {
      recipes: await Promise.all(
        rows.map(async (recipe) => ({
          ...recipe,
          costing: await this.costing(actor, recipe),
        })),
      ),
    };
  }

  async recipe(
    actor: ActorContext,
    id: string,
  ): Promise<{ recipe: RecipeDetailDto }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const recipe = await this.persistence.recipe(actor.shop.id, id);
    const costing = await this.costing(actor, recipe);
    const sources = await this.persistence.recipeSources(actor.shop.id, id);
    return { recipe: { ...recipe, costing, sources } };
  }

  async orderable(
    actor: ActorContext,
  ): Promise<{ recipes: OrderableRecipeDto[] }> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const rows = await this.persistence.listRecipes(actor.shop.id, {
      includeInactive: false,
      includeUnverified: false,
    });
    const costed = await Promise.all(
      rows.map(async (recipe): Promise<OrderableRecipeDto | null> => {
        const costing = await this.costing(actor, recipe);
        if (!costing.costComplete) return null;
        return {
          id: recipe.id,
          name: recipe.name,
          imageUrl: recipe.imageUrl,
          yieldQuantity: recipe.yieldQuantity,
          yieldUnit: recipe.yieldUnit,
          costComplete: true,
          unitCost: costing.unitCost,
          retailPrice: costing.retailPrice,
        };
      }),
    );
    return {
      recipes: costed.filter(
        (recipe): recipe is OrderableRecipeDto => recipe !== null,
      ),
    };
  }
}

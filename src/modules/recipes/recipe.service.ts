import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { DomainAudit } from '../../lib/domainAudit.js';
import { RecipePersistence } from './recipe.persistence.js';
import type { DatabaseTransaction } from '../../db/types.js';
import type { CommitEffect } from '../sync/sync.service.js';
import { convertEditedIngredients } from '../../lib/recipeEdits.js';
import { costRecipe } from './recipe.costing.js';
import { RecipeDeletionPersistence } from './recipe-deletion.persistence.js';
import { prepareManualProduct, type manualProductSchema } from '../../lib/manualProduct.js';
import { prepareBarcodePrice } from '../../lib/recipeBarcodePrice.js';
import { searchProduct } from '../../lib/supermarket/product-search.js';
import type { z } from 'zod';
import type { BarcodePriceInput, BarcodePriceDto, CreateRecipeInput, RecipePatchInput, VerifyRecipeInput,
  RecipeQuery, CostedRecipeDto, RecipeDetailDto, OrderableRecipeDto, RecipeDto } from './contracts.js';
export const RECIPE_COMMIT_EFFECTS = Symbol('RECIPE_COMMIT_EFFECTS');
export const RECIPE_SEARCH = Symbol('RECIPE_SEARCH');
@Injectable()
export class RecipeService {

  constructor(
    @Inject(RecipePersistence)
    private readonly persistence: RecipePersistence,
    @Inject(DomainAudit)
    private readonly audit: DomainAudit = new DomainAudit(),
    @Optional()
    @Inject(RECIPE_COMMIT_EFFECTS)
    private readonly afterCommit?: CommitEffect,
    @Optional()
    @Inject(RECIPE_SEARCH)
    private readonly search: typeof searchProduct = searchProduct,
  ) {}

  inTransaction(
    transaction: DatabaseTransaction,
    afterCommit: CommitEffect,
  ): RecipeService {
    return new RecipeService(
      new RecipePersistence(transaction),
      this.audit,
      afterCommit,
      this.search,
    );
  }

  private async committed(effect: () => Promise<void>): Promise<void> {
    if (this.afterCommit) this.afterCommit(effect);
    else await effect();
  }

  async deleteRecipe(
    actor: ActorContext,
    id: string,
  ): Promise<{ ok: true; mode: 'hard' | 'soft' }> {
    requireActorRole(actor, ['owner', 'admin']);
    const result = await new RecipeDeletionPersistence(
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
  async manualProduct(
    actor: ActorContext,
    id: string,
    input: z.infer<typeof manualProductSchema>,
  ) {
    requireActorRole(actor, ['owner', 'admin']);
    await this.persistence.assertRecipe(actor.shop.id, id);
    return {
      product: await this.persistence.manualProduct(
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
    await this.persistence.assertRecipe(actor.shop.id, id);
    const { price, quantity } = await prepareBarcodePrice(input, this.search);
    const priceId = await this.persistence.barcodePrice(price);
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

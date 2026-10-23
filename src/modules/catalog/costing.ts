import { toNumber } from '../../lib/money.js';
import { calculateRetailPrice, calculateUnitCost, ingredientLineCost, checkBatchStock } from '../../lib/pricing.js';
import { readRecipeCostIngredients, type CatalogReadDatabase } from './catalog.persistence.js';
import type { RecipeCostingInput, RecipeCostingDto } from './contracts.js';

/** One costing implementation shared by catalog transports and application use cases. */
export async function costRecipe(
  shopId: string,
  recipe: RecipeCostingInput,
  shopMargin: string,
  hourlyLaborCost: string,
  database?: CatalogReadDatabase,
): Promise<RecipeCostingDto> {
  const ingredientRows = await readRecipeCostIngredients(shopId, recipe.id, database);
  const lineCosts = ingredientRows.map((i) => ingredientLineCost({
    quantity: i.baseUnitAmount, averageUnitCost: i.averageUnitCost,
  }));
  const linkedIngredients = ingredientRows.filter((_, index) => lineCosts[index] !== null);
  const totalCount = ingredientRows.length;
  const linkedCount = linkedIngredients.length;

  const breakdown = calculateUnitCost({
    ingredients: ingredientRows.map((i) => ({
      quantity: i.baseUnitAmount,
      averageUnitCost: i.averageUnitCost,
    })),
    prepTimeMinutes: recipe.prepTimeMinutes,
    hourlyLaborCost,
    yieldQuantity: recipe.yieldQuantity,
  });

  const fullyLinked = breakdown.costComplete;

  const { retailPrice, appliedMarginPercent } = calculateRetailPrice(
    breakdown.unitCost,
    shopMargin,
    fullyLinked ? recipe.targetMarginPct : null,
  );

  const finalRetailPrice = fullyLinked ? retailPrice : null;

  const batchAvailable =
    fullyLinked &&
    linkedIngredients.every((ingredient) => {
      const stock = checkBatchStock({
        requiredQuantity: toNumber(ingredient.quantity),
        currentQuantity: toNumber(ingredient.currentQuantity ?? '0'),
      });
      return stock.inStock;
    });

  return {
    costComplete: fullyLinked,
    unresolvedCount: breakdown.unresolvedCount,
    unitCost: fullyLinked ? breakdown.unitCost : null,
    ingredientsCost: breakdown.ingredientsCost,
    laborCost: breakdown.laborCost,
    batchCost: fullyLinked ? breakdown.batchCost : null,
    retailPrice: finalRetailPrice,
    appliedMarginPercent: fullyLinked ? appliedMarginPercent : '0.00',
    yieldQuantity: toNumber(recipe.yieldQuantity),
    inStock: batchAvailable,
    linkedCount,
    totalCount,
    ingredients: ingredientRows.map((ingredient, index) => ({
      id: ingredient.id,
      name: ingredient.name ?? ingredient.rawName,
      quantity: toNumber(ingredient.quantity),
      rawSrcUnit: ingredient.rawSrcUnit,
      rawMaterialName: ingredient.rawMaterialName,
      baseUnit: ingredient.baseUnit,
      baseUnitAmount: ingredient.baseUnitAmount,
      averageUnitCost: ingredient.averageUnitCost == null ? null : toNumber(ingredient.averageUnitCost),
      lineCost: lineCosts[index] == null ? null : Math.round(lineCosts[index]! * 10_000) / 10_000,
      currentQuantity: ingredient.currentQuantity ? toNumber(ingredient.currentQuantity) : 0,
      inventoryItemId: ingredient.inventoryItemId,
      generalPriceId: ingredient.generalPriceId,
      rawName: ingredient.rawName,
      linked: lineCosts[index] !== null,
    })),
  };
}

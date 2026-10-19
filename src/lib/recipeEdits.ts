import { convertRecipeToBaseUnits } from './recipeConversion.js';
import type { RecipeIngredient } from './gemini.js';

type EditedIngredient = {
  rawName: string;
  rawMaterialName?: string;
  quantity: number;
  rawSrcUnit: string;
};

/** Recalculate edited source quantities with the existing recipe conversion rules. */
export function convertEditedIngredients<T extends EditedIngredient>(ingredients: readonly T[]) {
  const converted = convertRecipeToBaseUnits({
    name: null, description: null, prepTimeMinutes: null,
    yieldQuantity: null, yieldUnit: null, allergens: [], steps: [],
    ingredients: ingredients.map((ingredient): RecipeIngredient => ({
      rawName: ingredient.rawName,
      rawMaterialName: ingredient.rawMaterialName ?? ingredient.rawName,
      quantity: ingredient.quantity,
      rawSrcUnit: ingredient.rawSrcUnit,
      baseUnit: null,
      baseUnitAmount: null,
    })),
  });
  return ingredients.map((ingredient, index) => ({
    ...ingredient,
    baseUnit: converted.ingredients[index]!.baseUnit,
    baseUnitAmount: converted.ingredients[index]!.baseUnitAmount,
  }));
}

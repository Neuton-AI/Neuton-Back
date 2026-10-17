import type { RecipeExtraction } from './gemini.js';
import { convertMeasurement } from './unitConversion.js';

/** Convert the total amount required by each line, without using product/package data. */
export function convertRecipeToBaseUnits(recipe: RecipeExtraction): RecipeExtraction {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => {
      const { baseUnit, baseUnitAmount } = convertMeasurement(ingredient.quantity, ingredient.rawSrcUnit);
      return { ...ingredient, baseUnit, baseUnitAmount };
    }),
  };
}

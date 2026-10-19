import type { RecipeExtraction, RecipeIngredient } from './gemini.js';
import { convertSrcAmountToBase, getBaseAndCurrentUnit } from './supermarket/conversion.js';

export function convertIngredientToBaseUnit(ingredient: RecipeIngredient): RecipeIngredient {
  const unresolved = { ...ingredient, baseUnit: null, baseUnitAmount: null };
  const { quantity, rawSrcUnit } = ingredient;
  if (quantity === null || !Number.isFinite(quantity) || quantity <= 0 || !rawSrcUnit?.trim()) {
    return unresolved;
  }

  // A package or compound measure needs information the recipe does not provide.
  // Do not let the shared text matcher pick just one unit out of such a phrase.
  const unit = rawSrcUnit.trim();
  if (!/^[\p{L}"'״׳]+[.,]?$/u.test(unit) || /^מארז(?:ים)?[.,]?$/u.test(unit)) {
    return unresolved;
  }
  const found = getBaseAndCurrentUnit(unit);
  const converted = convertSrcAmountToBase({
    srcUnit: found.current,
    srcUnitAmount: quantity,
    baseUnit: found.base,
    baseUnitAmount: null as number | null,
  });
  if (converted.baseUnitAmount === null || !Number.isFinite(converted.baseUnitAmount)) {
    return unresolved;
  }
  return { ...ingredient, baseUnit: converted.baseUnit, baseUnitAmount: converted.baseUnitAmount };
}

/** Uses receipt ratios; unresolved lines have both base fields null. Never uses package sizes. */
export function convertRecipeToBaseUnits<T extends RecipeExtraction>(recipe: T): T {
  return { ...recipe, ingredients: recipe.ingredients.map(convertIngredientToBaseUnit) };
}

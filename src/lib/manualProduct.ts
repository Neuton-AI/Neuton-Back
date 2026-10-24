import { z } from 'zod';
import { badRequest } from './errors.js';
import { htmlFree } from './safeText.js';
import { convertEditedIngredients } from './recipeEdits.js';

export const manualProductSchema = z.object({
  name: htmlFree(z.string().trim().min(1).max(160)),
  price: z.number().finite().nonnegative().max(99999999.99),
  packageSize: z.number().finite().min(0.001).max(999999999.999),
  packageUnit: z.enum(['g', 'kg', 'ml', 'l', 'pcs']),
  rawMaterialName: htmlFree(z.string().trim().min(1).max(160)),
  quantity: z.number().finite().positive().max(999999999.999),
  rawSrcUnit: htmlFree(z.string().trim().min(1).max(24)),
});

/** quantity/rawSrcUnit are the user's recipe usage, not the old extraction. */
export function prepareManualProduct(input: z.infer<typeof manualProductSchema>) {
  const [product, ingredient] = convertEditedIngredients([
    { rawName: input.name, quantity: input.packageSize, rawSrcUnit: input.packageUnit },
    { rawName: input.name, quantity: input.quantity, rawSrcUnit: input.rawSrcUnit },
  ]);
  if (!product?.baseUnit || !product.baseUnitAmount || !ingredient?.baseUnitAmount ||
      Number(product.baseUnitAmount.toFixed(3)) <= 0 || Number(ingredient.baseUnitAmount.toFixed(3)) <= 0 ||
      product.baseUnit !== ingredient.baseUnit) {
    throw badRequest('Package unit must be compatible with the ingredient unit');
  }
  const cost = input.price / product.baseUnitAmount;
  if (cost >= 1e12 || (cost > 0 && Number(cost.toFixed(6)) === 0)) {
    throw badRequest('Package price per base unit is outside the supported precision');
  }
  return {
    rawName: input.name,
    rawMaterialName: input.name,
    sku: null,
    rawSrcUnit: input.packageUnit,
    srcUnit: input.packageUnit === 'pcs' ? 'each' : input.packageUnit,
    baseUnit: product.baseUnit,
    baseUnitAmount: product.baseUnitAmount.toFixed(3),
    baseUnitCost: cost.toFixed(6),
  };
}

import { badRequest, notFound } from './errors.js';
import { convertEditedIngredients } from './recipeEdits.js';
import { normalizePriceName, selectFallbackProduct } from './recipePriceFallback.js';
import { getValidSkuEnrichment, searchProduct } from './supermarket/prices.js';
import { normalizeProductPrice } from './supermarket/productConversion.js';

type BarcodePriceInput = {
  barcode: string;
  rawMaterialName: string;
  quantity: number;
  rawSrcUnit: string;
};

/** Resolve an exact SKU, including a zero-padded GTIN-14 equivalent of an EAN-13. */
export async function prepareBarcodePrice(input: BarcodePriceInput, search = searchProduct) {
  const materialName = normalizePriceName(input.rawMaterialName);
  if (!materialName) throw badRequest('The ingredient needs a material name');
  let matches = await getValidSkuEnrichment(input.barcode, search);
  if (matches.length === 0 && /^0\d{13}$/.test(input.barcode)) {
    matches = await getValidSkuEnrichment(input.barcode.slice(1), search);
  }
  const product = selectFallbackProduct(matches);
  if (!product) throw notFound('No supermarket product found for this barcode');
  const price = normalizeProductPrice(product, materialName);
  if (!price) throw badRequest('This product has no usable package measurement or price');

  const [ingredient] = convertEditedIngredients([{ ...input, rawName: input.rawMaterialName }]);
  if (!ingredient?.baseUnit || !ingredient.baseUnitAmount) {
    throw badRequest('The ingredient amount and unit could not be converted');
  }
  if (ingredient.baseUnit !== price.baseUnit) {
    throw badRequest('The product unit does not match the ingredient unit');
  }
  return { price, quantity: Number(product.Quantity) };
}

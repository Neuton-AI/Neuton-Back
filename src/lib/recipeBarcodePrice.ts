import { badRequest, notFound } from './errors.js';
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
  let matches = await getValidSkuEnrichment(input.barcode, search);
  if (matches.length === 0 && /^0\d{13}$/.test(input.barcode)) {
    matches = await getValidSkuEnrichment(input.barcode.slice(1), search);
  }
  const product = selectFallbackProduct(matches);
  if (!product) throw notFound('No supermarket product found for this barcode');
  const price = normalizeProductPrice(product, normalizePriceName(product.ItemName));
  if (!price) throw badRequest('This product has no usable package measurement or price');

  return { price, quantity: Number(product.Quantity) };
}

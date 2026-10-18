import type { ExtractedLineItem } from '../gemini.js';
import { setUnitsData } from './conversion.js';
import type { PriceResult } from './prices.js';

function positiveDecimal(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Run the selected product through the receipt enrichment conversion pipeline. */
export function normalizeProductPrice(product: PriceResult, rawMaterialName: string) {
  const price = positiveDecimal(product.ItemPrice);
  if (price === null || positiveDecimal(product.Quantity) === null ||
      !product.ItemCode.trim() || !product.ItemName.trim()) return null;

  const item: ExtractedLineItem = {
    rawName: product.ItemName,
    rawMaterialName,
    rawSku: product.ItemCode.trim(),
    isSkuEnriched: true,
    quantity: 1,
    rawSrcUnit: product.UnitQty,
    srcUnit: null,
    srcUnitAmount: null,
    baseUnit: null,
    baseUnitAmount: null,
    unitPrice: price,
    totalPrice: price,
    confidence: null,
  };
  // The selected product is already known, so use the receipt SKU-enrichment
  // path. setUnitsData derives units from UnitQty and amounts from Quantity.
  setUnitsData([{ item, itemEnrichment: [product] }]);
  const baseAmount = item.baseUnitAmount;
  if (baseAmount === null || !Number.isFinite(baseAmount) || baseAmount <= 0 || baseAmount >= 1e21) return null;
  const cost = price / baseAmount;
  if (!Number.isFinite(cost) || cost >= 1e12) return null;
  const baseUnitAmount = baseAmount.toFixed(3);
  const baseUnitCost = cost.toFixed(6);
  if (Number(baseUnitAmount) <= 0 || Number(baseUnitCost) <= 0 || Number(baseUnitCost) >= 1e12) return null;
  return {
    rawName: item.rawName, sku: item.rawSku, rawMaterialName,
    rawSrcUnit: item.rawSrcUnit, srcUnit: item.srcUnit, baseUnit: item.baseUnit,
    baseUnitAmount, baseUnitCost,
  };
}

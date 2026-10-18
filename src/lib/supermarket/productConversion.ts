import { convertSrcAmountToBase, getBaseAndCurrentUnit } from './conversion.js';
import type { PriceResult } from './prices.js';

function positiveDecimal(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Package contents for ordinary products; declared price basis for weighted goods. */
export function normalizeProductPrice(product: PriceResult, rawMaterialName: string) {
  const price = positiveDecimal(product.ItemPrice);
  const weighted = product.bIsWeighted.trim();
  if (price === null || !product.ItemCode.trim() || !product.ItemName.trim()) return null;
  if (!['', '0', '1'].includes(weighted)) return null;

  const rawSrcUnit = weighted === '1' ? product.UnitOfMeasure : product.UnitQty;
  // Weighted price bases may include a multiplier (e.g. "100 גרם").
  // Quantity is not the amount covered by that price.
  const measure = rawSrcUnit.trim().match(/^(?:(\d+(?:\.\d+)?)\s*)?([\p{L}"'״׳]+[.,]?)$/u);
  if (!measure || (weighted !== '1' && measure[1])) return null;
  const unit = measure[2]!;
  if (/^מארז(?:ים)?[.,]?$/u.test(unit)) return null;
  const amount = weighted === '1'
    ? positiveDecimal(measure[1] ?? '1')
    : positiveDecimal(product.Quantity);
  if (amount === null) return null;
  const found = getBaseAndCurrentUnit(unit);
  if (!found.base || (weighted === '1' && found.base !== 'g')) return null;
  const converted = convertSrcAmountToBase({
    srcUnit: found.current, srcUnitAmount: amount, baseUnit: found.base,
    baseUnitAmount: null as number | null,
  });
  const baseAmount = converted.baseUnitAmount;
  if (baseAmount === null || !Number.isFinite(baseAmount) || baseAmount <= 0 || baseAmount >= 1e21) return null;
  const cost = price / baseAmount;
  if (!Number.isFinite(cost) || cost >= 1e12) return null;
  const baseUnitAmount = baseAmount.toFixed(3);
  const baseUnitCost = cost.toFixed(6);
  if (Number(baseUnitAmount) <= 0 || Number(baseUnitCost) <= 0 || Number(baseUnitCost) >= 1e12) return null;
  return {
    rawName: product.ItemName, sku: product.ItemCode.trim(), rawMaterialName,
    rawSrcUnit, srcUnit: found.current, baseUnit: found.base,
    baseUnitAmount, baseUnitCost,
  };
}

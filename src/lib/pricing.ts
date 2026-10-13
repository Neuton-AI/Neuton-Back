import { parseNumber } from './measurements.js';
import { round, toNumber } from './money.js';

export interface RecipeIngredientInput {
  quantity: number | string | null | undefined;
  averageUnitCost: number | string | null | undefined;
}

export interface UnitCostInput {
  ingredients: RecipeIngredientInput[];
  prepTimeMinutes: number;
  hourlyLaborCost: number | string | null | undefined;
  yieldQuantity: number | string | null | undefined;
}

export interface UnitCostBreakdown {
  /** Σ (ingredient quantity × weighted moving average unit cost) */
  ingredientsCost: number;
  /** (prep minutes ÷ 60) × hourly labor cost */
  laborCost: number;
  /** materials + labor */
  batchCost: number | null;
  /** batchCost ÷ yield quantity */
  unitCost: number | null;
  yieldQuantity: number | null;
}

export interface StockCheckInput {
  /** Σ (required per batch ÷ yield quantity × quantity ordered) */
  requiredQuantity: number;
  currentQuantity: number;
}

export interface StockCheck {
  inStock: boolean;
  /** How many batches of the ordered quantity the current stock supports. */
  batchesAvailable: number;
  shortfall: number;
}

/**
 * Inputs must already share a verified quantity/rate basis. Use recipeCosting for raw measurements.
 * Unit Cost = ( Σ(ingredient qty × average_unit_cost) + (prep_minutes ÷ 60 × hourly_labor_cost) ) ÷ yield_quantity
 */
export function calculateUnitCost(input: UnitCostInput): UnitCostBreakdown {
  const ingredientsCost = input.ingredients.reduce(
    (sum, ingredient) => sum + toNumber(ingredient.quantity) * toNumber(ingredient.averageUnitCost),
    0,
  );
  const laborCost = (input.prepTimeMinutes / 60) * toNumber(input.hourlyLaborCost);
  const yieldQuantity = parseNumber(input.yieldQuantity);
  const complete = yieldQuantity !== null && yieldQuantity > 0 && input.ingredients.every(i => parseNumber(i.quantity) !== null && Number(i.quantity) > 0 && parseNumber(i.averageUnitCost) !== null && Number(i.averageUnitCost) >= 0);
  const batchCost = complete ? ingredientsCost + laborCost : null;

  return {
    ingredientsCost: round(ingredientsCost, 4),
    laborCost: round(laborCost, 4),
    batchCost: batchCost === null ? null : round(batchCost, 6),
    unitCost: batchCost === null ? null : round(batchCost / yieldQuantity!, 6),
    yieldQuantity,
  };
}

/**
 * Retail Price = Unit Cost × (1 + target_profit_margin ÷ 100)
 * A recipe-level margin overrides the shop-level margin.
 */
export function calculateRetailPrice(
  unitCost: number,
  shopMarginPercent: number | string | null | undefined,
  recipeMarginPercent?: number | string | null,
): { retailPrice: number; appliedMarginPercent: number } {
  const appliedMarginPercent = round(
    toNumber(recipeMarginPercent ?? shopMarginPercent),
    2,
  );
  const retailPrice = unitCost * (1 + appliedMarginPercent / 100);
  return { retailPrice: round(retailPrice, 2), appliedMarginPercent };
}

/**
 * Delivery Fee = base_fee + (distance_km × rate_per_km)
 */
export function calculateDeliveryFee(
  distanceKm: number | string | null | undefined,
  baseFee: number | string | null | undefined,
  ratePerKm: number | string | null | undefined,
): number {
  const distance = Math.max(toNumber(distanceKm), 0);
  return round(toNumber(baseFee) + distance * toNumber(ratePerKm), 2);
}

/** "In Stock?" yield indicator for the recipe detail sheet. */
export function checkBatchStock(input: StockCheckInput): StockCheck {
  const required = Math.max(input.requiredQuantity, 0);
  const available = Math.max(input.currentQuantity, 0);
  const batchesAvailable = required > 0 ? Math.floor((available / required) * 100) / 100 : 0;

  return {
    inStock: available + 1e-9 >= required,
    batchesAvailable,
    shortfall: round(Math.max(required - available, 0), 3),
  };
}

export interface InventoryCostUpdate {
  currentQuantity: number;
  lastUnitCost: number;
  /** Weighted moving average unit cost after the purchase. */
  averageUnitCost: number;
}

/**
 * Weighted moving average: new_avg = (old_qty × old_avg + purchased_qty × unit_price) ÷ (old_qty + purchased_qty)
 */
export function applyWeightedAverage(
  current: {
    currentQuantity: number | string | null | undefined;
    averageUnitCost: number | string | null | undefined;
  },
  purchase: { quantity: number; unitPrice: number },
): InventoryCostUpdate {
  const oldQuantity = Math.max(toNumber(current.currentQuantity), 0);
  const oldAverage = toNumber(current.averageUnitCost);
  const purchased = Math.max(purchase.quantity, 0);
  const newQuantity = round(oldQuantity + purchased, 6);
  const newAverage =
    newQuantity > 0 ? (oldQuantity * oldAverage + purchased * purchase.unitPrice) / newQuantity : oldAverage;

  return {
    currentQuantity: newQuantity,
    lastUnitCost: round(purchase.unitPrice, 10),
    averageUnitCost: round(newAverage, 10),
  };
}

export interface OrderTotalsInput {
  items: { quantity: number; unitCost: number | null; unitPrice: number | null }[];
  deliveryFee: number;
}

/** Net profit = billed amount − delivery fee − production cost. */
export function calculateOrderTotals(input: OrderTotalsInput) {
  const totalCost = input.items.reduce(
    (sum, item) => sum + item.quantity * (item.unitCost ?? 0),
    0,
  );
  const itemsSubtotal = input.items.reduce(
    (sum, item) => sum + item.quantity * (item.unitPrice ?? 0),
    0,
  );
  const costsComplete = input.items.every(i => i.unitCost !== null);
  const pricesComplete = input.items.every(i => i.unitPrice !== null);
  const totalAmount = pricesComplete ? round(itemsSubtotal + input.deliveryFee, 2) : null;
  const deliveryFee = round(input.deliveryFee, 2);
  const netProfit = costsComplete && totalAmount !== null ? round(totalAmount - deliveryFee - totalCost, 2) : null;

  return {
    totalCost: costsComplete ? round(totalCost, 2) : null,
    knownCostSubtotal: round(totalCost, 2),
    costingComplete: costsComplete,
    totalAmount,
    deliveryFee,
    netProfit,
    profitMarginPercent:
      netProfit !== null && totalAmount !== null ? totalAmount > 0 ? round((netProfit / totalAmount) * 100, 2) : 0 : null,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid] ?? 0;
  if (sorted.length % 2 === 0) {
    const prev = sorted[mid - 1] ?? midValue;
    return round((prev + midValue) / 2, 2);
  }
  return round(midValue, 2);
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return round(total / values.length, 2);
}


import { money, round, toNumber, unitCost } from './money.js';

export interface RecipeIngredientInput {
  /** Converted amount in the canonical base unit. */
  quantity: number | string | null | undefined;
  /** Price per matching base unit, or null when conversion/linking is unresolved. */
  averageUnitCost: number | string | null | undefined;
}

export interface UnitCostInput {
  ingredients: RecipeIngredientInput[];
  prepTimeMinutes: number;
  hourlyLaborCost: number | string | null | undefined;
  yieldQuantity: number | string | null | undefined;
}

interface UnitCostSubtotal {
  unresolvedCount: number;
  /** Resolved ingredient subtotal; partial when costComplete is false. */
  ingredientsCost: number;
  /** (prep minutes ÷ 60) × hourly labor cost */
  laborCost: number;
  /** materials + labor */
  batchCost: number;
  yieldQuantity: number;
}

export type UnitCostBreakdown = UnitCostSubtotal & (
  | { costComplete: true; unitCost: number }
  | { costComplete: false; unitCost: number | null }
);

export interface OrderPricing {
  unitPrice: string;
  unitCost: string;
  costComplete: boolean;
}

export interface OrderPricingResult {
  orderPricing: OrderPricing | null;
  orderPricingError: {
    code: 'INVALID_RECIPE_YIELD';
    message: string;
  } | null;
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

/** Missing converted amounts and prices stay unresolved; a valid zero price is allowed. */
export function ingredientLineCost(ingredient: RecipeIngredientInput): number | null {
  const { quantity, averageUnitCost } = ingredient;
  if (quantity == null || averageUnitCost == null || quantity === '' || averageUnitCost === '') return null;
  const amount = Number(quantity);
  const price = Number(averageUnitCost);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price < 0) return null;
  const cost = amount * price;
  return Number.isFinite(cost) ? cost : null;
}

/** Sum converted line costs, add batch labor, then divide by recipe yield. */
export function calculateUnitCost(input: UnitCostInput): UnitCostBreakdown {
  const lineCosts = input.ingredients.map(ingredientLineCost);
  const unresolvedCount = lineCosts.filter((cost) => cost === null).length;
  const yieldQuantity = Number(input.yieldQuantity);
  const validYield = Number.isFinite(yieldQuantity) && yieldQuantity > 0;
  const costComplete = input.ingredients.length > 0 && unresolvedCount === 0 && validYield;
  const ingredientsCost = lineCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const laborCost = (input.prepTimeMinutes / 60) * toNumber(input.hourlyLaborCost);
  const batchCost = ingredientsCost + laborCost;
  const subtotal = {
    unresolvedCount,
    ingredientsCost: round(ingredientsCost, 4),
    laborCost: round(laborCost, 4),
    batchCost: round(batchCost, 4),
    yieldQuantity: toNumber(input.yieldQuantity),
  };
  if (costComplete) {
    return { ...subtotal, costComplete: true, unitCost: round(batchCost / yieldQuantity, 4) };
  }
  return {
    ...subtotal,
    costComplete: false,
    unitCost: validYield ? round(batchCost / yieldQuantity, 4) : null,
  };
}

/** Shared selling policy for catalog projections and reviewed order creation. */
export function calculateOrderPricing(
  breakdown: UnitCostBreakdown,
  shopMarginPercent: number | string | null | undefined,
  recipeMarginPercent?: number | string | null,
): OrderPricingResult {
  if (breakdown.unitCost === null) {
    return {
      orderPricing: null,
      orderPricingError: {
        code: 'INVALID_RECIPE_YIELD',
        message: 'Recipe yield must be a finite positive number',
      },
    };
  }
  let sellingPrice = breakdown.unitCost;
  if (breakdown.costComplete) {
    sellingPrice = calculateRetailPrice(breakdown.unitCost, shopMarginPercent, recipeMarginPercent).retailPrice;
  }
  return {
    orderPricing: {
      unitPrice: money(sellingPrice),
      unitCost: unitCost(breakdown.unitCost),
      costComplete: breakdown.costComplete,
    },
    orderPricingError: null,
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
  const newQuantity = round(oldQuantity + purchased, 3);
  const newAverage =
    newQuantity > 0 ? (oldQuantity * oldAverage + purchased * purchase.unitPrice) / newQuantity : oldAverage;

  return {
    currentQuantity: newQuantity,
    lastUnitCost: round(purchase.unitPrice, 4),
    averageUnitCost: round(newAverage, 4),
  };
}

export interface OrderTotalsInput {
  items: { quantity: number; unitCost: number; unitPrice: number; costComplete?: boolean | null }[];
  deliveryFee: number;
}

/** Known partial costs remain in totals; partial-cost sales contribute no profit. */
export function calculateOrderTotals(input: OrderTotalsInput) {
  const totalCost = input.items.reduce(
    (sum, item) => sum + item.quantity * item.unitCost,
    0,
  );
  const itemsSubtotal = input.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  const totalAmount = round(itemsSubtotal + input.deliveryFee, 2);
  const deliveryFee = round(input.deliveryFee, 2);
  let netProfit = round(totalAmount - deliveryFee - totalCost, 2);
  if (input.items.some(item => item.costComplete === false)) {
    const completeItems = input.items.filter(item => item.costComplete !== false);
    const completeRevenue = completeItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const completeCost = completeItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    netProfit = round(completeRevenue - completeCost, 2);
  }

  return {
    totalCost: round(totalCost, 2),
    totalAmount,
    deliveryFee,
    netProfit,
    profitMarginPercent:
      totalAmount > 0 ? round((netProfit / totalAmount) * 100, 2) : 0,
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

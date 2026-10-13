import { canonicalUnit, normalizeMeasurement, parseMeasurementText, parseNumber, unresolved, type Resolution } from './measurements.js';

export interface PurchaseInput {
  rawName: string; quantity: unknown; unit: unknown; unitPrice: unknown; totalPrice: unknown;
  packageQuantity?: unknown; packageUnit?: unknown; packagesPerPurchase?: unknown;
  currency?: string | null; expectedCurrency?: string | null; discountConfirmed?: boolean;
}
export interface NormalizedPurchase extends Resolution { paidAmount: number | null; rate: number | null }
export function normalizePurchase(input: PurchaseInput): NormalizedPurchase {
  const count = parseNumber(input.quantity);
  const paid = parseNumber(input.totalPrice);
  const unitPrice = parseNumber(input.unitPrice);
  const fail = (reason: string): NormalizedPurchase => ({ ...unresolved(reason), paidAmount: paid, rate: null });
  if (!input.currency || input.currency !== (input.expectedCurrency ?? 'ILS')) return fail('unsupported_currency');
  if (count === null || count <= 0) return fail('missing_quantity');
  const amount = paid ?? (unitPrice !== null ? count * unitPrice : null);
  if (amount === null || amount < 0) return fail('missing_price');
  // Accounting rounding is allowed; discounts require explicit confirmation.
  if (paid !== null && unitPrice !== null && Math.abs(count * unitPrice - paid) > .011 && !input.discountConfirmed) return fail('conflicting_price');
  const purchasedUnit = canonicalUnit(input.unit);
  let resolution = normalizeMeasurement(count, input.unit);
  if (purchasedUnit === 'each' || purchasedUnit === 'pack') {
    const explicit = input.packageQuantity != null || input.packageUnit != null;
    const supplied = explicit ? normalizeMeasurement(input.packageQuantity, input.packageUnit).measurement : null;
    const named = parseMeasurementText(input.rawName);
    if (explicit && !supplied) return fail('missing_package_size');
    if (named && supplied && (named.unit !== supplied.unit || Math.abs(named.quantity - supplied.quantity) > 1e-6)) return fail('conflicting_measurements');
    const contents = supplied ?? named;
    const multiplier = input.packagesPerPurchase == null ? 1 : parseNumber(input.packagesPerPurchase);
    if (multiplier === null || multiplier <= 0) return fail('missing_package_size');
    if (contents) resolution = { state: 'ready', reason: null, measurement: { quantity: count * multiplier * contents.quantity, unit: contents.unit }, provenance: [supplied ? 'confirmed-package' : 'receipt-name'] };
    else if (purchasedUnit === 'pack') return fail('missing_package_size');
    // A food package sold as "unit" needs contents unless it is explicitly an each item.
    else if (!/^(eggs?|ביצים|ביצה|each:)/i.test(input.rawName)) return fail('missing_package_size');
  }
  if (!resolution.measurement) return { ...resolution, paidAmount: amount, rate: null };
  return { ...resolution, paidAmount: amount, rate: amount / resolution.measurement.quantity };
}

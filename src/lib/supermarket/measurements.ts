import { canonicalUnit, normalizeMeasurement, parseMeasurementText, parseNumber, unresolved, type Resolution } from '../measurements.js';
export type CatalogRecord = Record<string, string>;
export function resolveCatalogMeasurement(record: CatalogRecord): Resolution {
  const named = parseMeasurementText(record.ItemName ?? '');
  const quantity = parseNumber(record.Quantity);
  const unit = canonicalUnit(record.UnitQty);
  const comparison = parseMeasurementText(record.UnitOfMeasure ?? '') ??
    normalizeMeasurement(1, record.UnitOfMeasure).measurement;
  const price = parseNumber(record.ItemPrice);
  const comparisonPrice = parseNumber(record.UnitOfMeasurePrice);
  const weighted = record.bIsWeighted === '1';
  // Weighted feeds quote a measured basis, not the contents of a package.
  let contents = weighted ? normalizeMeasurement(1, record.UnitQty).measurement
    : normalizeMeasurement(quantity, unit).measurement;
  // Adapter: when UnitQty is absent, Quantity is absolute ml/g in the
  // comparison dimension. The comparison denominator is never a multiplier.
  if (!contents && !unit && quantity !== null && comparison) contents = { quantity, unit: comparison.unit };
  if (!contents) contents = named;
  if (!contents) return unresolved('missing_package_size');
  if (named && (named.unit !== contents.unit || Math.abs(named.quantity - contents.quantity) > .01)) return unresolved('conflicting_measurements');
  // Quantity-size plausibility is an independent check; arithmetic alone can
  // validate the supplied 200-litre cheddar typo.
  if (contents.quantity > 25000 && !weighted) return unresolved('suspect_package_size');
  if (price === null || price < 0) return unresolved('missing_price');
  if (comparison && comparisonPrice !== null) {
    if (comparison.unit !== contents.unit ||
      Math.abs(price / contents.quantity * comparison.quantity - comparisonPrice) > .011) return unresolved('conflicting_measurements');
  }
  return { state: 'ready', reason: null, measurement: contents, provenance: ['pricefull-absolute-quantity-v1'] };
}
export function isFoodCandidate(name: string): boolean {
  return !/(חגורה|belt|detergent|סבון|שמפו|cleaner|ניקוי|צעצוע|בגדים|battery|סוללות)/i.test(name);
}

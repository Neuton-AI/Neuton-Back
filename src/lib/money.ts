/** Decimal-safe helpers for values returned by `numeric` columns (Drizzle returns strings). */

export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Money (2dp) as a string suitable for a `numeric(12,2)` column. */
export function money(value: number): string {
  return round(value, 2).toFixed(2);
}

/** Rates use 10dp; round money only at accounting/display boundaries. */
export function unitCost(value: number): string {
  return round(value, 10).toFixed(10);
}

/** Normalized quantities use 6dp (sub-milligram/ml precision). */
export function quantity(value: number): string {
  return round(value, 6).toFixed(6);
}

export function marginPercent(value: string | number | null | undefined): number {
  return round(toNumber(value), 2);
}

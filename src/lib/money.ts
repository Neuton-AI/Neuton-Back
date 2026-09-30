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

/** Unit costs need 4dp precision in storage. */
export function unitCost(value: number): string {
  return round(value, 4).toFixed(4);
}

/** Quantities use 3dp precision in storage. */
export function quantity(value: number): string {
  return round(value, 3).toFixed(3);
}

export function marginPercent(value: string | number | null | undefined): number {
  return round(toNumber(value), 2);
}

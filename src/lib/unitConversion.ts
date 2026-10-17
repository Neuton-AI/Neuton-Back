/** Shared measurement rules. Package contents and recipe-line amounts are mapped by callers. */
const UNITS = {
  g: { base: 'g', factor: 1, aliases: ['g', 'gr', 'gram', 'grams', 'גרם', 'גרמים', 'גרמ', 'ג'] },
  kg: { base: 'g', factor: 1000, aliases: ['kg', 'kilogram', 'kilograms', 'קג', 'קילוגרם', 'קילוגרמים', 'קילוגרמ'] },
  mg: { base: 'g', factor: 0.001, aliases: ['mg', 'milligram', 'milligrams', 'מג', 'מיליגרם', 'מיליגרמים'] },
  oz: { base: 'g', factor: 28.3495, aliases: ['oz', 'ounce', 'ounces'] },
  lb: { base: 'g', factor: 453.592, aliases: ['lb', 'lbs', 'pound', 'pounds'] },
  ml: { base: 'ml', factor: 1, aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'מל', 'מיל', 'סמק', 'מיליליטר', 'מיליליטרים'] },
  l: { base: 'ml', factor: 1000, aliases: ['l', 'liter', 'liters', 'litre', 'litres', 'ל', 'ליטר', 'ליטרים'] },
  each: { base: 'each', factor: 1, aliases: ['each', 'unit', 'units', 'piece', 'pieces', 'pc', 'pcs', 'יח', 'יחידה', 'יחידות', 'יחדה', 'יחדות'] },
  dozen: { base: 'each', factor: 12, aliases: ['dozen', 'dozens', 'dz', 'תריסר'] },
  'us tsp': { base: 'ml', factor: 4.92892, aliases: ['us tsp', 'us teaspoon', 'us teaspoons'] },
  'us tbsp': { base: 'ml', factor: 14.7868, aliases: ['us tbsp', 'us tablespoon', 'us tablespoons'] },
  'us cup': { base: 'ml', factor: 236.588, aliases: ['us cup', 'us cups'] },
} as const;

export type BaseUnit = 'g' | 'ml' | 'each';
export type SourceUnit = keyof typeof UNITS;

function normalizeUnit(value: string): string {
  return value.trim().toLowerCase().replace(/["'״׳.]/g, '').replace(/,$/, '').replace(/\s+/g, ' ');
}

export function resolveUnit(value: string | null | undefined): { current: SourceUnit; base: BaseUnit } | null {
  if (!value) return null;
  const normalized = normalizeUnit(value);
  for (const [current, definition] of Object.entries(UNITS)) {
    if ((definition.aliases as readonly string[]).includes(normalized)) {
      return { current: current as SourceUnit, base: definition.base };
    }
  }
  return null;
}

const FRACTIONS: Record<string, number> = { '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };

/** Strictly parse decimals, fractions and mixed fractions; never accept a numeric prefix of prose. */
export function parseMeasurementQuantity(value: unknown): number | null {
  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    const fraction = text.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
    const unicode = text.match(/^(\d*)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/);
    if (fraction) {
      amount = Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
    } else if (unicode) {
      amount = Number(unicode[1] || 0) + FRACTIONS[unicode[2]!]!;
    } else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      amount = Number(text);
    } else {
      return null;
    }
  } else {
    return null;
  }
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export type MeasurementConversion =
  | { baseUnit: BaseUnit; baseUnitAmount: number; unresolvedReason: null }
  | { baseUnit: null; baseUnitAmount: null; unresolvedReason: 'invalid-quantity' | 'unsupported-unit' | 'incompatible-unit' | 'invalid-base-amount' };

export function convertMeasurement(quantity: unknown, unit: string | null | undefined, targetBase?: BaseUnit): MeasurementConversion {
  const amount = parseMeasurementQuantity(quantity);
  if (amount === null) return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'invalid-quantity' };
  const source = resolveUnit(unit);
  if (!source) return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'unsupported-unit' };
  if (targetBase && source.base !== targetBase) {
    return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'incompatible-unit' };
  }
  const baseUnitAmount = amount * UNITS[source.current].factor;
  if (!Number.isFinite(baseUnitAmount) || baseUnitAmount <= 0) {
    return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'invalid-base-amount' };
  }
  return { baseUnit: source.base, baseUnitAmount, unresolvedReason: null };
}

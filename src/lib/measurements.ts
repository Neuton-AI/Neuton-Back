export type BaseUnit = 'g' | 'ml' | 'each';
export type Convention = 'us' | 'metric' | 'imperial';
export type MeasurementState = 'ready' | 'estimated' | 'unresolved';
export interface Measurement { quantity: number; unit: BaseUnit }
export interface Resolution {
  state: MeasurementState;
  reason: string | null;
  measurement: Measurement | null;
  provenance: string[];
}

const fractions: Record<string, number> = { '¼': .25, '½': .5, '¾': .75, '⅐': 1/7, '⅑': 1/9, '⅒': .1, '⅓': 1/3, '⅔': 2/3, '⅕': .2, '⅖': .4, '⅗': .6, '⅘': .8, '⅙': 1/6, '⅚': 5/6, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };

/** Strict quantity parsing; never strip unknown text or fraction separators. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/⁄/g, '/');
  const unicode = text.match(/^([+-]?\d+)?\s*([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/);
  if (unicode) {
    const whole = Number(unicode[1] ?? 0);
    return whole + (whole < 0 ? -1 : 1) * fractions[unicode[2]!]!;
  }
  const fraction = text.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (fraction) return Number(fraction[3]) > 0 ? Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]) : null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}

const aliases: Record<string, string> = {};
for (const [unit, names] of Object.entries({
  g: ['g', 'gram', 'grams', 'גרם', 'גרמים', 'ג'],
  kg: ['kg', 'kilogram', 'kilograms', 'קג', 'קילוגרם'],
  ml: ['ml', 'milliliter', 'milliliters', 'מיליליטר', 'מל'],
  l: ['l', 'liter', 'litre', 'liters', 'ליטר'],
  each: ['each', 'unit', 'units', 'piece', 'pieces', 'יחידה', 'יחידות', 'יח', 'pc', 'pcs'],
  pack: ['pack', 'package', 'packages', 'חבילה', 'אריזה'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  tsp: ['tsp', 'teaspoon', 'teaspoons', 'כפית', 'כפיות'],
  tbsp: ['tbsp', 'tablespoon', 'tablespoons', 'כף', 'כפות'],
  cup: ['cup', 'cups', 'כוס', 'כוסות'],
  floz: ['fl oz', 'fluid ounce', 'fluid ounces', 'floz'],
})) for (const name of names) aliases[name] = unit;

export function canonicalUnit(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return aliases[value.toLowerCase().trim().replace(/["'״׳.]/g, '').replace(/\s+/g, ' ')] ?? null;
}

export function unresolved(reason: string, provenance: string[] = []): Resolution {
  return { state: 'unresolved', reason, measurement: null, provenance };
}

export function normalizeMeasurement(quantity: unknown, unit: unknown, convention?: Convention | null): Resolution {
  const amount = parseNumber(quantity);
  if (amount === null || amount <= 0) return unresolved('missing_quantity');
  const key = canonicalUnit(unit);
  if (!key || key === 'pack') return unresolved(key === 'pack' ? 'missing_package_size' : 'unsupported_unit');
  const factors: Record<string, [BaseUnit, number]> = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], each: ['each', 1], oz: ['g', 28.349523125], lb: ['g', 453.59237] };
  let basis = factors[key];
  if (!basis) {
    if (!convention) return unresolved('ambiguous_unit');
    const volume = convention === 'us'
      ? { tsp: 4.92892159375, tbsp: 14.78676478125, cup: 236.5882365, floz: 29.5735295625 }
      : convention === 'metric' ? { tsp: 5, tbsp: 15, cup: 250, floz: 30 }
      : { tsp: 5.919388020833, tbsp: 17.7581640625, cup: 284.130625, floz: 28.4130625 };
    basis = ['ml', volume[key as keyof typeof volume]];
  }
  if (!basis[1]) return unresolved('unsupported_unit');
  return { state: 'ready', reason: null, measurement: { quantity: amount * basis[1], unit: basis[0] }, provenance: [`measurement-v1${convention ? ':' + convention : ''}`] };
}

/** Only measurement expressions with token boundaries, never letters in names. */
export function parseMeasurementText(text: string): Measurement | null {
  const matches = [...text.matchAll(/(?:^|[\s(])([0-9]+(?:\.[0-9]+)?)\s*(ק["״']?ג|מ["״']?ל|קילוגרם|מיליליטר|גרמים|גרם|ליטר|kg|ml|g|l|ג)(?=$|[\s).,])/gi)];
  const resolved = matches.map(m => normalizeMeasurement(m[1], m[2]).measurement).filter((m): m is Measurement => m !== null);
  if (resolved.length === 0) return null;
  const first = resolved[0]!;
  return resolved.every(m => m.unit === first.unit && Math.abs(m.quantity - first.quantity) < 1e-6) ? first : null;
}

export interface ConversionProfile {
  from: BaseUnit; to: BaseUnit; factor: number; source: string; version: string; estimated: boolean;
  convention?: Convention; qualifier?: string | null;
}
const chart = 'https://www.kingarthurbaking.com/learn/ingredient-weight-chart';
// US spoon/cup entries from the chart, never a universal grams-per-spoon factor.
const baking: Record<string, number> = {
  'baking powder': 4 / 4.92892159375, 'אבקת אפייה': 4 / 4.92892159375, 'אבקת אפיה': 4 / 4.92892159375,
  'flour': 120 / 236.5882365, 'קמח': 120 / 236.5882365,
  'sugar': 198 / 236.5882365, 'סוכר': 198 / 236.5882365,
  'butter': 113 / (236.5882365 / 2), 'חמאה': 113 / (236.5882365 / 2),
  'cocoa': 42 / (236.5882365 / 2), 'קקאו': 42 / (236.5882365 / 2),
};
export function convertRequirement(input: {
  quantity: unknown; unit: unknown; target: BaseUnit; ingredient: string;
  convention?: Convention | null; qualifier?: string | null; profile?: ConversionProfile | null;
}): Resolution {
  const result = normalizeMeasurement(input.quantity, input.unit, input.convention);
  if (!result.measurement || result.measurement.unit === input.target) return result;
  let profile = input.profile;
  const density = baking[input.ingredient.trim().toLowerCase()];
  if (!profile && density && input.convention === 'us' && !input.qualifier) {
    profile = { from: 'ml', to: 'g', factor: density, source: chart, version: 'ka-2026-10-v1', estimated: true, convention: 'us' };
  }
  if (!profile || profile.from !== result.measurement.unit || profile.to !== input.target ||
    !Number.isFinite(profile.factor) || profile.factor <= 0 ||
    (profile.convention && profile.convention !== input.convention) ||
    (profile.qualifier ?? null) !== (input.qualifier ?? null)) return unresolved('missing_ingredient_conversion', result.provenance);
  return { state: profile.estimated ? 'estimated' : 'ready', reason: null,
    measurement: { quantity: result.measurement.quantity * profile.factor, unit: profile.to },
    provenance: [...result.provenance, profile.source, profile.version] };
}

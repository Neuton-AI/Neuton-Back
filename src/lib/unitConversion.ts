/** Shared measurement rules. Package contents and recipe-line amounts are mapped by callers. */
const CONVERSION = {
  g: { g: 1, kg: 1000, mg: 0.001, oz: 28.3495, lb: 453.592 },
  ml: { ml: 1, l: 1000, 'us tsp': 4.92892, 'us tbsp': 14.7868, 'us cup': 236.588 },
  each: { each: 1, dozen: 12 },
};

const MASS_REGEX = {
  g: /(?:^|\s)(?:גרם|גרמ(?:ים)?|ג[״"']?),?(?!\p{L})/u,
  kg: /(?:^|\s)(?:קילוגרם|קילוגרמ(?:ים)?|ק["'״]?ג),?(?!\p{L})/u,
  mg: /(?:^|\s)(?:מיליגרם|מיליגרמ(?:ים)?|מ["'״]?ג),?(?!\p{L})/u,
};

const VOLUME_REGEX = {
  ml: /(?:^|\s)(?:מיליליטר(?:ים)?|מ["'״י]?ל|סמ["״]?ק|מל),?(?!\p{L})/u,
  l: /(?:^|\s)(?:ליטר(?:ים)?|ל),?(?!\p{L})/u,
};

const EACH_REGEX = {
  // Recognize packages separately: their contents are unknown, so they have no conversion factor.
  pack: /(?:^|\s)(?:מארז(?:ים)?),?(?!\p{L})/u,
  each: /(?:^|\s)(?:יחיד(?:ה|ות)|יחד(?:ה|ות)|מארז(?:ים)?|יח['״"]?)[,]?(?!\p{L})/u,
  dozen: /(?:^|\s)תריסר,?(?!\p{L})/u,
};

const ENGLISH_MASS_REGEX = {
  g: /(?:^|\s)(?:g|gr|grams?)\.?(?=$|[\s,])/i,
  kg: /(?:^|\s)(?:kg|kilograms?)\.?(?=$|[\s,])/i,
  mg: /(?:^|\s)(?:mg|milligrams?)\.?(?=$|[\s,])/i,
  oz: /(?:^|\s)(?:oz|ounces?)\.?(?=$|[\s,])/i,
  lb: /(?:^|\s)(?:lbs?|pounds?)\.?(?=$|[\s,])/i,
};

const ENGLISH_VOLUME_REGEX = {
  ml: /(?:^|\s)(?:ml|millilit(?:er|re)s?)\.?(?=$|[\s,])/i,
  l: /(?:^|\s)(?:l|lit(?:er|re)s?)\.?(?=$|[\s,])/i,
  'us tsp': /(?:^|\s)us\s+(?:tsp|teaspoons?)\.?(?=$|[\s,])/i,
  'us tbsp': /(?:^|\s)us\s+(?:tbsp|tablespoons?)\.?(?=$|[\s,])/i,
  'us cup': /(?:^|\s)us\s+cups?\.?(?=$|[\s,])/i,
};

const ENGLISH_EACH_REGEX = {
  pack: /(?:^|\s)packs?\.?(?=$|[\s,])/i,
  each: /(?:^|\s)(?:each|units?|pieces?|pcs?)\.?(?=$|[\s,])/i,
  dozen: /(?:^|\s)(?:dozens?|dz)\.?(?=$|[\s,])/i,
};

const measuresRegexes = {
  mass: [MASS_REGEX, ENGLISH_MASS_REGEX],
  volume: [VOLUME_REGEX, ENGLISH_VOLUME_REGEX],
  each: [EACH_REGEX, ENGLISH_EACH_REGEX],
};

const BASE_UNIT = { mass: 'g', volume: 'ml', each: 'each' } as const;

export type BaseUnit = keyof typeof CONVERSION;
export type SourceUnit = keyof typeof CONVERSION.g | keyof typeof CONVERSION.ml | keyof typeof CONVERSION.each | 'pack';

export function resolveUnit(value: string | null | undefined): { current: SourceUnit; base: BaseUnit } | null {
  if (!value) return null;
  const input = value.trim();
  const categories = Object.keys(measuresRegexes) as Array<keyof typeof measuresRegexes>;
  for (const category of categories) {
    for (const regexes of measuresRegexes[category]) {
      for (const [current, regex] of Object.entries(regexes)) {
        if (regex.test(input)) {
          return { current: current as SourceUnit, base: BASE_UNIT[category] };
        }
      }
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
  const conversions: Record<string, number> = CONVERSION[source.base];
  const factor = conversions[source.current];
  if (factor === undefined) return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'unsupported-unit' };
  const baseUnitAmount = amount * factor;
  if (!Number.isFinite(baseUnitAmount) || baseUnitAmount <= 0) {
    return { baseUnit: null, baseUnitAmount: null, unresolvedReason: 'invalid-base-amount' };
  }
  return { baseUnit: source.base, baseUnitAmount, unresolvedReason: null };
}

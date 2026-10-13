import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../db/client.js';
import { generalPrices, inventoryItems, recipeIngredients, recipes, ingredientConversions, productMeasurements, shops } from '../db/schema/index.js';
import { offerMeasurementKey } from './productIdentity.js';
import { calculateRetailPrice, checkBatchStock } from './pricing.js';
import { round } from './money.js';
import { convertRequirement, normalizeMeasurement, parseNumber, type BaseUnit, type Convention, type ConversionProfile } from './measurements.js';

export interface MeasurementContext {
  convention?: Convention | null; qualifier?: string | null;
  alternatives?: string[]; selectedAlternative?: string;
  alternateMeasurements?: { quantity: number | null; unit: string | null }[];
  profile?: ConversionProfile | null;
  catalogPackage?: { quantity: number; unit: BaseUnit; source: string; version: string };
}
export interface CostingLine {
  currency?: string; id?: string; rawName: string; searchAbleName?: string; name?: string | null;
  unit: string | null; quantity: string | number | null;
  inventoryItemId: string | null; generalPriceId: string | null;
  inventoryUnit?: string | null; inventoryStatus?: string | null;
  currentQuantity: string | number | null; averageUnitCost: string | number | null;
  packageQuantity?: string | null; packageUnit?: string | null; priceIls?: string | null;
  priceStatus?: string | null; priceReason?: string | null;
  measurementContext?: unknown; fetchedAt?: Date | null; sourceUpdatedAt?: string | null;
}

/** Pure readiness and stock policy reused by every database entry point. */
export function costNormalizedRecipe(recipe: { prepTimeMinutes: number; yieldQuantity: unknown; targetMarginPct?: string | null },
  rows: CostingLine[], shopMargin: string, hourlyLaborCost: string) {
  const ingredients = rows.map(row => {
    const context = (row.measurementContext ?? {}) as MeasurementContext;
    const historical = !!row.inventoryItemId;
    const inventoryBasis = normalizeMeasurement(1, row.inventoryUnit).measurement;
    const publicContents = context.catalogPackage ?? normalizeMeasurement(row.packageQuantity, row.packageUnit).measurement;
    const target = historical ? inventoryBasis?.unit : publicContents?.unit;
    const normalized = target ? convertRequirement({ quantity: row.quantity, unit: row.unit, target,
      ingredient: context.selectedAlternative ?? row.searchAbleName ?? row.rawName, convention: context.convention,
      qualifier: context.qualifier, profile: context.profile }) : null;
    let reason = normalized?.reason ?? null;
    if (!row.inventoryItemId && !row.generalPriceId) reason = 'unmatched_product';
    else if (historical && row.inventoryStatus !== 'ready') reason = 'legacy_reconciliation_required';
    else if (!historical && !context.catalogPackage && row.priceStatus !== 'ready') reason = row.priceReason ?? 'conflicting_measurements';
    else if (!target) reason = 'missing_package_size';
    if (!historical && row.currency && row.currency !== 'ILS') reason = 'unsupported_currency';
    if (context.alternatives?.length && !context.selectedAlternative) reason = 'unselected_alternative';
    const rate = historical ? parseNumber(row.averageUnitCost) === null ? null : Number(row.averageUnitCost) / (inventoryBasis?.quantity ?? 1)
      : parseNumber(row.priceIls) !== null && publicContents && publicContents.quantity > 0 ? Number(row.priceIls) / publicContents.quantity : null;
    if (!reason && (rate === null || rate < 0)) reason = 'missing_price';
    // Cross-check explicit alternate weights; volume estimates do not override printed grams.
    for (const alternate of context.alternateMeasurements ?? []) {
      const other = normalizeMeasurement(alternate.quantity, alternate.unit, context.convention).measurement;
      if (other && normalized?.measurement && other.unit === normalized.measurement.unit &&
        Math.abs(other.quantity - normalized.measurement.quantity) > Math.max(.01, normalized.measurement.quantity * .05)) reason = 'conflicting_measurements';
    }
    const measurement = normalized?.measurement ?? null;
    const state = reason ? 'unresolved' as const : !historical || normalized?.state === 'estimated' ? 'estimated' as const : 'ready' as const;
    const lineCost = state === 'unresolved' || !measurement || rate === null ? null : measurement.quantity * rate;
    return { ...row, name: row.name ?? row.searchAbleName ?? row.rawName, quantity: parseNumber(row.quantity), linked: !!(row.inventoryItemId || row.generalPriceId),
      measurementState: state, measurementReason: reason, normalizedQuantity: measurement?.quantity ?? null,
      normalizedUnit: measurement?.unit ?? null, averageUnitCost: rate, lineCost,
      priceBasis: historical ? 'historical_inventory' : 'replacement_estimate',
      provenance: [...(normalized?.provenance ?? []), ...(context.catalogPackage ? [context.catalogPackage.source, context.catalogPackage.version] : [])], convention: context.convention ?? null, qualifier: context.qualifier ?? null,
      alternatives: context.alternatives ?? [], selectedAlternative: context.selectedAlternative ?? null,
      alternateMeasurements: context.alternateMeasurements ?? [],
      explanation: lineCost === null ? reason : `${measurement!.quantity} ${measurement!.unit} × ${rate} ${row.currency ?? 'ILS'}/${measurement!.unit}`,
    };
  });
  const yieldQuantity = parseNumber(recipe.yieldQuantity);
  const yieldValid = yieldQuantity !== null && yieldQuantity > 0;
  const costableCount = ingredients.filter(i => i.lineCost !== null).length;
  const complete = yieldValid && ingredients.length > 0 && costableCount === ingredients.length;
  const knownSubtotal = ingredients.reduce((sum, i) => sum + (i.lineCost ?? 0), 0);
  const laborCost = recipe.prepTimeMinutes / 60 * (parseNumber(hourlyLaborCost) ?? 0);
  const batchCost = complete ? knownSubtotal + laborCost : null;
  const unitCost = batchCost !== null ? batchCost / yieldQuantity! : null;
  const retail = unitCost !== null ? calculateRetailPrice(unitCost, shopMargin, recipe.targetMarginPct) : null;
  const requirements = new Map<string, { requiredQuantity: number; currentQuantity: number; unit: BaseUnit }>();
  for (const i of ingredients) {
    if (!i.inventoryItemId || i.normalizedQuantity === null || !i.normalizedUnit || i.measurementState === 'unresolved') continue;
    const prior = requirements.get(i.inventoryItemId);
    requirements.set(i.inventoryItemId, { requiredQuantity: (prior?.requiredQuantity ?? 0) + i.normalizedQuantity,
      currentQuantity: (parseNumber(i.currentQuantity) ?? 0) * (normalizeMeasurement(1, i.inventoryUnit).measurement?.quantity ?? 1), unit: i.normalizedUnit });
  }
  return { currency: rows[0]?.currency ?? 'ILS', unitCost: unitCost === null ? null : round(unitCost, 6), batchCost: batchCost === null ? null : round(batchCost, 6),
    ingredientsCost: round(knownSubtotal, 6), knownSubtotal: round(knownSubtotal, 6), laborCost: round(laborCost, 6),
    retailPrice: retail?.retailPrice ?? null, appliedMarginPercent: retail?.appliedMarginPercent ?? null,
    yieldQuantity, complete, measurementState: !complete ? 'unresolved' : ingredients.some(i => i.measurementState === 'estimated') ? 'estimated' : 'ready',
    reasons: [...new Set([...ingredients.map(i => i.measurementReason).filter(Boolean), ...(!yieldValid ? ['invalid_yield'] : [])])],
    inStock: complete && ingredients.every(i => !!i.inventoryItemId) && [...requirements.values()].every(r => checkBatchStock(r).inStock),
    stockRequirements: [...requirements.entries()].map(([inventoryItemId, r]) => ({ inventoryItemId, ...r })),
    linkedCount: ingredients.filter(i => i.linked).length, costableCount, totalCount: ingredients.length, ingredients };
}

export async function costRecipe(shopId: string, recipe: typeof recipes.$inferSelect,
  shopMargin: string, hourlyLaborCost: string, database: Pick<Database, 'select'> = db) {
  const rows = await database.select({
    currency: shops.currency, id: recipeIngredients.id, inventoryItemId: recipeIngredients.inventoryItemId, generalPriceId: recipeIngredients.generalPriceId,
    rawName: recipeIngredients.rawName, searchAbleName: recipeIngredients.searchAbleName,
    unit: recipeIngredients.unit, quantity: recipeIngredients.quantity, measurementContext: recipeIngredients.measurementContext,
    name: sql<string>`coalesce(${inventoryItems.name}, ${generalPrices.name})`,
    inventoryUnit: inventoryItems.unit, inventoryStatus: inventoryItems.measurementStatus,
    currentQuantity: inventoryItems.currentQuantity, averageUnitCost: inventoryItems.averageUnitCost,
    packageQuantity: generalPrices.packageQuantity, packageUnit: generalPrices.packageUnit,
    priceIls: generalPrices.priceIls, priceStatus: generalPrices.measurementStatus, priceReason: generalPrices.measurementReason,
    fetchedAt: generalPrices.fetchedAt, sourceUpdatedAt: generalPrices.sourceUpdatedAt,
    barcode: generalPrices.barcode, chain: generalPrices.chain, offerKey: generalPrices.offerKey,
  }).from(recipeIngredients).innerJoin(shops, eq(shops.id, recipeIngredients.shopId)).leftJoin(inventoryItems, and(eq(inventoryItems.id, recipeIngredients.inventoryItemId), eq(inventoryItems.shopId, shopId)))
    .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
    .where(and(eq(recipeIngredients.shopId, shopId), eq(recipeIngredients.recipeId, recipe.id))).orderBy(asc(recipeIngredients.id));
  const overrides = await database.select().from(ingredientConversions).where(eq(ingredientConversions.shopId, shopId));
  const savedPackages = await database.select().from(productMeasurements).where(eq(productMeasurements.shopId, shopId));
  for (const row of rows) {
    const context = { ...(row.measurementContext ?? {}) } as MeasurementContext;
    const override = overrides.find(o => o.scopeKey === 'product:' + row.inventoryItemId) ??
      overrides.find(o => o.scopeKey === 'ingredient:' + (row.searchAbleName ?? row.rawName).trim().toLowerCase());
    if (!context.profile && override) context.profile = override.profile as ConversionProfile;
    if (!row.inventoryItemId && row.offerKey && row.chain && !context.catalogPackage) {
      const saved = savedPackages.find(p => p.productKey === offerMeasurementKey({ barcode: row.barcode, chain: row.chain!, offerKey: row.offerKey! }));
      const contents = saved ? normalizeMeasurement(saved.packageQuantity, saved.packageUnit).measurement : null;
      if (saved && contents) context.catalogPackage = { ...contents, quantity: contents.quantity * Number(saved.packagesPerPurchase), source: 'shop-confirmed-product', version: saved.updatedAt.toISOString() };
    }
    row.measurementContext = context;
  }
  return costNormalizedRecipe(recipe, rows, shopMargin, hourlyLaborCost);
}

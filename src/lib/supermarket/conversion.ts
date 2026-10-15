import type { ExtractedLineItem } from "../gemini.js"
import { type PriceResult } from "./prices.js"

export type BaseUnits = keyof typeof CONVERSION

const CONVERSION = {
    g: { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 },
    ml: { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588 },
    each: { each: 1, dozen: 12 },
}


const MASS_REGEX = {
    g: /(?:^|\s)(?:גרם|גרמ(?:ים)?|ג[״"']?),?(?!\p{L})/u,
    kg: /(?:^|\s)(?:קילוגרם|קילוגרמ(?:ים)?|ק["'״]?ג),?(?!\p{L})/u,
    mg: /(?:^|\s)(?:מיליגרם|מיליגרמ(?:ים)?|מ["'״]?ג),?(?!\p{L})/u,
}

const VOLUME_REGEX = {
    ml: /(?:^|\s)(?:מיליליטר(?:ים)?|מ["'י]?ל|סמ"ק|מל),?(?!\p{L})/u,
    l: /(?:^|\s)(?:ליטר(?:ים)?|ל),?(?!\p{L})/u,
}

const EACH_REGEX = {
    each: /(?:^|\s)(?:יחיד(?:ה|ות)|יחד(?:ה|ות)|מארז(?:ים)?|יח['״"]?)[,]?(?!\p{L})/u,
}

const measuresRegexes = {
    mass: MASS_REGEX,
    volume: VOLUME_REGEX,
    each: EACH_REGEX,
}

const BASE_UNIT = { mass: 'g', volume: 'ml', each: 'each' } as const;

export const getBaseAndCurrentUnit = (input: string) => {
    const categories = Object.keys(measuresRegexes) as Array<keyof typeof measuresRegexes>;

    for (const category of categories) {
        for (const [unit, regex] of Object.entries(measuresRegexes[category])) {
            if (regex.test(input)) {
                return { current: unit, base: BASE_UNIT[category] };
            }
        }
    }

    return { current: input, base: null };
};

const getScoredUnits = (itemEnrichment: PriceResult[], item: ExtractedLineItem) => {
    const scoredUnits: { base: Record<string, number>; current: Record<string, number> } = {
        base: {},
        current: {},
    }

    const recordScore = (found: { current: string; base: string | null } | null) => {
        if (!found) return
        if (found.base) {
            scoredUnits.base[found.base] = (scoredUnits.base[found.base] || 0) + 1
        }
        if (found.current) {
            scoredUnits.current[found.current] = (scoredUnits.current[found.current] || 0) + 1
        }
    }

    if (item.srcUnit) {
        recordScore(getBaseAndCurrentUnit(item.srcUnit))
    }
    if (item.baseUnit) {
        recordScore(getBaseAndCurrentUnit(item.baseUnit))
    }
    for (const enrichmentItem of itemEnrichment) {
        if (enrichmentItem.UnitQty) {
            recordScore(getBaseAndCurrentUnit(enrichmentItem.UnitQty))
        }
    }

    const getMaxEntry = (record: Record<string, number>): string | null => {
        return Object.entries(record).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null
    }

    const maxBase = getMaxEntry(scoredUnits.base)
    const maxCurrent = getMaxEntry(scoredUnits.current)

    return { base: maxBase, current: maxCurrent }
}

export const setSrcUnitAmount = (enrichedList: {
    item: ExtractedLineItem;
    itemEnrichment: PriceResult[] | null;
}[]) => {
    return enrichedList.map(({ item, itemEnrichment }) => {
        item.srcUnitAmount = (itemEnrichment && itemEnrichment[0]?.Quantity)
            ? +itemEnrichment[0].Quantity
            : null
        return { item, itemEnrichment }
    })
}

export const setUnitsData = (enrichedList: {
    item: ExtractedLineItem;
    itemEnrichment: PriceResult[] | null;
}[]) => {
    enrichedList.map(({ item, itemEnrichment }) => {
        let foundUnits;
        if (itemEnrichment && itemEnrichment?.[0]) {
            foundUnits = item.isSkuEnriched ? getBaseAndCurrentUnit(itemEnrichment[0].UnitQty) : getScoredUnits(itemEnrichment, item)
        } else {
            foundUnits = item.srcUnit ? getBaseAndCurrentUnit(item.srcUnit) : null
        }
        item.baseUnit = foundUnits?.base as BaseUnits || null
        item.srcUnit = foundUnits?.current ?? item.srcUnit
        return { item, itemEnrichment }
    })
    const listWithAmounts = setSrcUnitAmount(enrichedList)
    listWithAmounts.forEach(({ item }) => {
        convertSrcAmountToBase(item)
    })
    return listWithAmounts
}

export const convertSrcAmountToBase = (item: ExtractedLineItem) => {
    const { srcUnit, srcUnitAmount, baseUnit } = item
    if (!srcUnit || !srcUnitAmount || !baseUnit) return item
    const conversions: Record<string, number> = CONVERSION[baseUnit]
    const ratio = conversions[srcUnit] ?? null
    item.baseUnitAmount = ratio ? srcUnitAmount * ratio : null
    return item
}

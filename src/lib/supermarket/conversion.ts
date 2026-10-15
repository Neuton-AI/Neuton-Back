import type { ExtractedLineItem } from "../gemini.js"
import { enrichReciptItems, type PriceResult } from "./prices.js"

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
    let units = null
    const scoredUnits: any = { base: {}, current: {} }
    const itemSrcFound: any = item.srcUnit ? getBaseAndCurrentUnit(item.srcUnit) : null
    const itemBaseFound: any = item.baseUnit ? getBaseAndCurrentUnit(item.baseUnit) : null

    if (itemSrcFound !== null) {
        scoredUnits.base[itemSrcFound.base]++
        scoredUnits.current[itemSrcFound.current]++
    }
    if (itemBaseFound !== null) {
        scoredUnits.base[itemBaseFound.base]++
        scoredUnits.current[itemBaseFound.current]++
    }
    for (const item of itemEnrichment) {
        const found = getBaseAndCurrentUnit(item.UnitQty)
        found.base && scoredUnits.base[found.base]++
        found.current && scoredUnits.current[found.current]++
    }
    const maxBase = 
    const maxCurrent = 

    return { base: maxBase, current: maxCurrent }
}

export const setSrcUnitAmount = (enrichedList: {
    item: ExtractedLineItem;
    itemEnrichment: PriceResult[] | null;
}[]) => {
    return enrichedList.map(({ item, itemEnrichment }) => {
        item.srcUnitAmount = (item.isSkuEnriched && itemEnrichment && itemEnrichment[0]?.Quantity)
            ? +itemEnrichment[0].Quantity
            : null
        return { item, itemEnrichment }
    })
}

export const setUnitsData = (enrichedList: {
    item: ExtractedLineItem;
    itemEnrichment: PriceResult[] | null;
}[]) => {
    return enrichedList.map(({ item, itemEnrichment }) => {
        let foundUnits;
        if (itemEnrichment && itemEnrichment?.[0]) {

            foundUnits = item.isSkuEnriched ? getBaseAndCurrentUnit(itemEnrichment[0].UnitQty) : getScoredUnits(itemEnrichment, item)

        } else {

        }
        item.baseUnit = foundUnits?.base ?? null
        item.srcUnit = foundUnits?.current ?? null
        return { item, itemEnrichment }
    })
}
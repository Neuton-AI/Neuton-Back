import type { ExtractedLineItem } from "../gemini.js"
import { type PriceResult } from "./prices.js"

import { convertMeasurement, parseMeasurementQuantity, resolveUnit, type BaseUnit } from "../unitConversion.js"

export type BaseUnits = BaseUnit

export const getBaseAndCurrentUnit = (input: string) => {
    return resolveUnit(input) ?? { current: input, base: null }
}

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
        item.srcUnitAmount = parseMeasurementQuantity(itemEnrichment?.[0]?.Quantity)
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
    const result = convertMeasurement(item.srcUnitAmount, item.srcUnit, item.baseUnit ?? undefined)
    item.baseUnit = result.baseUnit
    item.baseUnitAmount = result.baseUnitAmount
    return item
}

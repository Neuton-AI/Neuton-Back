import { env } from '../../env.js';
import type { ReceiptExtraction } from '../gemini.js';
import { apiLogger } from '../logger/index.js';
import { createScrapySearch, ScrapyApiError, type ProductSearch } from './scrapy-api.js';

export type { ScrapyProduct as PriceResult } from './scrapy-api.js';

const remoteSearch = createScrapySearch({
  baseUrl: env.SCRAPY_API_BASE_URL,
  timeoutMs: env.SCRAPY_API_TIMEOUT_MS,
});

export const searchProduct: ProductSearch = async (query, queryType = 'name') => {
  try {
    return await remoteSearch(query, queryType);
  } catch (error) {
    apiLogger.warn({
      event: 'supermarket_search_failed', queryType,
      ...(error instanceof ScrapyApiError ? {
        reason: error.reason, upstreamStatus: error.upstreamStatus,
        retryAfterSeconds: error.retryAfterSeconds, upstreamRequestId: error.requestId,
      } : { reason: 'invalid_query' }),
    }, 'Supermarket search failed');
    throw error;
  }
};

export async function getValidSkuEnrichment(sku: string, search: ProductSearch = searchProduct) {
  return (await search(sku, 'sku')).filter(item => item.itemCode === sku);
}

export async function getValidNameEnrichment(name: string, search: ProductSearch = searchProduct) {
  return (await search(name, 'name')).filter(item => item.itemName?.toLowerCase() === name.toLowerCase());
}

export async function getScoredEnrichment(rawName: string, rawMaterialName: string, search: ProductSearch = searchProduct) {
  const results = await Promise.all([search(rawName, 'name'), search(rawMaterialName, 'name')]);
  return results.flat().sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function enrichReciptItems(extraction: ReceiptExtraction, search: ProductSearch = searchProduct) {
  // Enrichment is optional; an API failure must not discard an extracted receipt.
  const availableSearch: ProductSearch = async (query, type) => {
    try { return await search(query, type); } catch { return []; }
  };
  return Promise.all(extraction.items.map(async item => {
    let itemEnrichment = item.rawSku ? await getValidSkuEnrichment(item.rawSku, availableSearch) : [];
    item.isSkuEnriched = itemEnrichment.length > 0;
    if (!item.isSkuEnriched) itemEnrichment = await getValidNameEnrichment(item.rawName, availableSearch);
    if (!itemEnrichment.length) {
      itemEnrichment = await getScoredEnrichment(item.rawName, item.rawMaterialName, availableSearch);
    }
    return { item, itemEnrichment };
  }));
}

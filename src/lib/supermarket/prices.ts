import { ReceiptExtraction } from '../gemini.js';
import {
  decodeHtmlEntities,
  extractHtmlBlocks,
  extractXmlBlocks,
  extractXmlElement,
  fetchText,
  fetchXml,
} from './client.js';

export type PriceChain = 'shufersal' | 'carrefour';

export interface ShufersalFileEntry {
  name: string;
  url: string;
  date: string;
}

export interface PriceResult extends FoundItem {
  chain: PriceChain;
  score: number;
}

export type FoundItem = Record<typeof PRICE_ITEM_FIELDS[number], string>

const PRICE_ITEM_FIELDS = [
  "PriceUpdateTime",
  "ItemCode",
  "LastSaleDateTime",
  "ItemType",
  "ItemName",
  "ManufactureName",
  "ManufactureCountry",
  "ManufactureItemDescription",
  "UnitQty",
  "Quantity",
  "UnitOfMeasure",
  "bIsWeighted",
  "QtyInPackage",
  "ItemPrice",
  "UnitOfMeasurePrice",
  "AllowDiscount",
  "ItemStatus"
] as const;

const fileUrlCache = new Map<PriceChain, { url: string; expiresAt: number }>();

function getCacheTtlMs(): number {
  return 6 * 60 * 60 * 1000; // 6 hours
}

export function parseShufersalFileList(html: string): ShufersalFileEntry[] {
  const entries: ShufersalFileEntry[] = [];

  const fileLinks = html.match(/href="([^"]*(?:\.gz|\.xml)[^"]*)"/gi) ?? [];

  for (const link of fileLinks) {
    const urlMatch = link.match(/href="([^"]*)"/i);
    if (!urlMatch) continue;

    let fileUrl = decodeHtmlEntities(urlMatch[1] ?? '');
    if (fileUrl.startsWith('/')) {
      fileUrl = `https://prices.shufersal.co.il${fileUrl}`;
    }

    const nameMatch = fileUrl.match(/([^/]+\.(?:gz|xml))(?:\?|$)/i);
    const name = nameMatch?.[1] ?? fileUrl;

    const dateMatch = name.match(/(\d{8})/);
    const date = dateMatch
      ? `${dateMatch[1]?.slice(0, 4)}-${dateMatch[1]?.slice(4, 6)}-${dateMatch[1]?.slice(6, 8)}`
      : 'unknown';

    entries.push({ name, url: fileUrl, date });
  }

  const rows = extractHtmlBlocks(html, 'tr');
  for (const row of rows) {
    const linkMatch = row.match(/href="([^"]*(?:\.gz|\.xml)[^"]*)"/i);
    if (!linkMatch) continue;

    const url = decodeHtmlEntities(linkMatch[1] ?? '');
    if (!url) continue;
    let fileUrl = url;
    if (fileUrl.startsWith('/')) {
      fileUrl = `https://prices.shufersal.co.il${fileUrl}`;
    }

    if (entries.some((e) => e.url === fileUrl)) continue;

    const nameMatch = fileUrl.match(/([^/]+\.(?:gz|xml))(?:\?|$)/i);
    const name = nameMatch?.[1] ?? fileUrl;
    const dateMatch = name.match(/(\d{8})/);
    const date = dateMatch
      ? `${dateMatch[1]?.slice(0, 4)}-${dateMatch[1]?.slice(4, 6)}-${dateMatch[1]?.slice(6, 8)}`
      : 'unknown';

    entries.push({ name, url: fileUrl, date });
  }

  return entries;
}

export function parsePublishPriceFileList(html: string, baseUrl: string): string[] {
  const files: string[] = [];

  try {
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      for (const script of scriptMatches) {
        if (script.includes('files') && script.includes('path')) {
          const fileMatch = script.match(/files\s*=\s*(\[.*?\])/s);
          const pathMatch = script.match(/path\s*=\s*["']([^"']*)["']/);

          if (fileMatch?.[1]) {
            try {
              const parsed = JSON.parse(fileMatch[1]);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (typeof item === 'string') {
                    const fileName = item;
                    const path = pathMatch?.[1] ?? '';
                    let fullUrl: string;
                    if (path) {
                      fullUrl = `${baseUrl.replace(/\/$/, '')}/${path}/${fileName}`;
                    } else {
                      fullUrl = `${baseUrl.replace(/\/$/, '')}/${fileName}`;
                    }
                    if (fullUrl) files.push(fullUrl);
                  } else if (item && typeof item === 'object' && 'name' in item) {
                    const fileName = String((item as any).name);
                    const path = pathMatch?.[1] ?? '';
                    let fullUrl: string;
                    if (path) {
                      fullUrl = `${baseUrl.replace(/\/$/, '')}/${path}/${fileName}`;
                    } else {
                      fullUrl = `${baseUrl.replace(/\/$/, '')}/${fileName}`;
                    }
                    if (fullUrl) files.push(fullUrl);
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    }

    if (files.length === 0) {
      const linkMatches = html.match(/href="([^"]*\.(?:gz|xml)[^"]*)"/gi) ?? [];
      for (const link of linkMatches) {
        const urlMatch = link.match(/href="([^"]*)"/i);
        if (!urlMatch) continue;
        const url = decodeHtmlEntities(urlMatch[1] ?? '');
        if (url) {
          let fullUrl: string;
          if (url.startsWith('http')) {
            fullUrl = url;
          } else if (url.startsWith('/')) {
            fullUrl = `${baseUrl.replace(/\/$/, '')}${url}`;
          } else {
            fullUrl = `${baseUrl.replace(/\/$/, '')}/${url}`;
          }
          files.push(fullUrl);
        }
      }
    }
  } catch {
    // ignore
  }

  return files;
}

async function getLatestShufersalFileUrl(): Promise<string> {
  const cached = fileUrlCache.get('shufersal');
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const listingUrl =
    'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&sort=Time&sortdir=DESC';
  const html = await fetchText(listingUrl);
  const entries = parseShufersalFileList(html);

  const pricefull = entries.find((e) => e.name.toLowerCase().includes('pricefull'));
  const candidate = pricefull || entries.find((e) => e.name.endsWith('.xml') || e.name.endsWith('.gz'));
  if (!candidate) {
    throw new Error('No PriceFull file found for Shufersal');
  }

  let url = candidate.url;
  if (url.startsWith('//')) {
    url = `https:${url}`;
  }

  fileUrlCache.set('shufersal', {
    url,
    expiresAt: Date.now() + getCacheTtlMs(),
  });
  return url;
}

async function getLatestCarrefourFileUrl(): Promise<string> {
  const cached = fileUrlCache.get('carrefour');
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const baseUrl = 'https://prices.carrefour.co.il/';
  const html = await fetchText(baseUrl);
  const files = parsePublishPriceFileList(html, baseUrl);

  const pricefull = files.find((f) => f.toLowerCase().includes('pricefull'));
  const candidate = pricefull || files.find((f) => f.endsWith('.xml') || f.endsWith('.gz'));
  if (!candidate) {
    throw new Error('No PriceFull file found for Carrefour');
  }

  let url = candidate;

  fileUrlCache.set('carrefour', {
    url,
    expiresAt: Date.now() + getCacheTtlMs(),
  });
  return url;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s\-ּ׳״(),.]+/).filter(Boolean);
}

function scoreMatch(name: string, barcode: string, manufacturer: string, query: string): number {
  const q = normalizeQuery(query);
  const b = barcode.toLowerCase();
  const m = manufacturer.toLowerCase();

  // Barcode exact match always wins
  if (q && b === q) return 10000;
  if (q && b.includes(q)) return 9000;

  // Exact full-name match
  if (q && name.toLowerCase() === q) return 9500;

  // Tokenize
  const qTokens = tokenize(query);
  const nTokens = tokenize(name);
  const mTokens = tokenize(manufacturer);

  if (qTokens.length === 0) return 0;

  // Query -> Name direction (recall): how many query tokens appear in name
  const matchedTokens = qTokens.filter(t => nTokens.includes(t));
  const recallRatio = matchedTokens.length / qTokens.length;
  if (recallRatio === 0) return 0;

  // Name -> Query direction (precision): penalize extra tokens in name not in query
  const extraTokens = nTokens.filter(t => !qTokens.includes(t));
  const extraRatio = extraTokens.length / nTokens.length;

  // Base score: recall * (1 - extraRatio) - penalizes names with lots of extra stuff
  let score = Math.round(5000 * recallRatio * (1 - extraRatio));

  // Position bonus: query tokens appearing early in name
  const firstMatchIdx = nTokens.findIndex(t => qTokens.includes(t));
  if (firstMatchIdx === 0) {
    score += 3000;  // massive bonus for index 0 (product type)
  } else if (firstMatchIdx === 1) {
    score += 500;
  } else if (firstMatchIdx >= 2) {
    score += Math.max(0, 200 - firstMatchIdx * 50);
  }

  // Manufacturer token overlap (small boost)
  const manOverlap = qTokens.filter(t => mTokens.includes(t)).length;
  score += manOverlap * 200;

  // Logarithmic length penalty: longer names get slightly reduced score
  // log(3)≈1.1, log(8)≈2.1, log(20)≈3.0 - gentle curve
  const lenFactor = 1 / Math.log(Math.max(2, nTokens.length));
  score = Math.round(score * lenFactor);

  // Floor at 0
  return Math.max(0, score);
}

export function parseXmlItems(xml: string): Array<FoundItem> {
  const blocks = extractXmlBlocks(xml, 'Item', PRICE_ITEM_FIELDS);
  const items: Array<FoundItem> = [];
  for (const block of blocks) {
    let item: any = {};
    for (const property of PRICE_ITEM_FIELDS) {
      item[property] = extractXmlElement(block, property) ?? '';
    }
    items.push(item);
  }
  return items;
}

export async function searchProduct(query: string, limitPerChain = 15): Promise<PriceResult[]> {
  if (!query || query.trim().length === 0) return [];

  const results: PriceResult[] = [];

  const tasks: Array<Promise<void>> = [];

  tasks.push(
    (async () => {
      try {
        const url = await getLatestShufersalFileUrl();
        const xml = await fetchXml(url);
        const items = parseXmlItems(xml);
        const scored = items
          .map((item) => ({
            item,
            score: scoreMatch(item.ItemName, item.ItemCode, item.ManufactureName, query),
          }))
          .filter((s) => s.score > 0);
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, limitPerChain);
        for (const s of top) {
          const price = parseFloat(s.item.ItemPrice);
          if (Number.isFinite(price)) {
            results.push({
              chain: 'shufersal',
              score: s.score,
              ...s.item,
            });
          }
        }
      } catch (err) {
        // ignore per-chain errors
      }
    })(),
  );

  tasks.push(
    (async () => {
      try {
        const url = await getLatestCarrefourFileUrl();
        const xml = await fetchXml(url);
        const items = parseXmlItems(xml);
        const scored = items
          .map((item) => ({
            item,
            score: scoreMatch(item.ItemName, item.ItemCode, item.ManufactureName, query),
          }))
          .filter((s) => s.score > 0);
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, limitPerChain);
        for (const s of top) {
          const price = parseFloat(s.item.ItemPrice);
          if (Number.isFinite(price)) {
            results.push({
              chain: 'carrefour',
              score: s.score,
              ...s.item,
            });
          }
        }
      } catch (err) {
        // ignore per-chain errors
      }
    })(),
  );

  await Promise.allSettled(tasks);

  results.sort((a, b) => b.score - a.score);

  return results;
}

export const enrichReciptItems = async (extraction: ReceiptExtraction, search: typeof searchProduct = searchProduct) => {
  const receiptItemsWithEnrichment = await Promise.all(extraction.items.map(async (item) => {
    let itemEnrichment = null

    itemEnrichment = item.rawSku ? await getValidSkuEnrichment(item.rawSku, search) : null
    item.isSkuEnriched = (itemEnrichment !== null && itemEnrichment.length > 0)

    if (!item.isSkuEnriched) {
      itemEnrichment = await getValidNameEnrichment(item.rawName, search)
    }

    if ((itemEnrichment && itemEnrichment.length === 0) || itemEnrichment === null) {
      itemEnrichment = await getScoredEnrichment(item.rawName, item.rawMaterialName, search)
    }
    return {
      item,
      itemEnrichment
    }
  }))

  return receiptItemsWithEnrichment
}

export const getValidSkuEnrichment = async (sku: string, search: typeof searchProduct = searchProduct) => {
  const enriched: PriceResult[] = [];
  const found = await search(sku)
  for (const item of found) {
    item.ItemCode == sku && enriched.push(item);
  }

  return enriched
}

export const getValidNameEnrichment = async (name: string, search: typeof searchProduct = searchProduct) => {
  const enriched: PriceResult[] = [];
  const found = await search(name, 5)
  for (const item of found) {
    item.ItemName.toLowerCase() === name.toLowerCase() && enriched.push(item);
  }

  return enriched
}

export const getScoredEnrichment = async (rawName: string, rawMaterialName: string, search: typeof searchProduct = searchProduct) => {
  const [rawNameScored, rawMaterialNameScored] = await Promise.all([
    search(rawName),
    search(rawMaterialName),
  ])

  const scored = [...rawNameScored, ...rawMaterialNameScored].sort((a, b) => b.score - a.score)

  return scored.slice(0, 5)
}

import { z } from 'zod';
import { AppError } from '../errors.js';

// The API returns raw camelCase columns, not normalized package fields.
const productSchema = z.object({
  chainId: z.string().min(1),
  itemCode: z.string().min(1),
  itemName: z.string().nullable(),
  manufactureName: z.string().nullable(),
  itemPrice: z.string().nullable(),
  quantity: z.string().nullable(),
  unitQty: z.string().nullable(),
  score: z.number().finite(),
}).passthrough();

export type ScrapyProduct = z.infer<typeof productSchema>;
export type QueryType = 'name' | 'sku';
export type ProductSearch = (query: string, queryType?: QueryType) => Promise<ScrapyProduct[]>;

export class ScrapyApiError extends AppError {
  constructor(
    readonly reason: 'http' | 'timeout' | 'network' | 'response',
    readonly upstreamStatus?: number,
    readonly retryAfterSeconds?: number,
    readonly requestId?: string,
  ) {
    super(503, 'SUPERMARKET_UNAVAILABLE', 'Supermarket search is temporarily unavailable');
    this.name = 'ScrapyApiError';
  }
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}

export function createScrapySearch(options: {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}): ProductSearch {
  const endpoint = new URL('/v1/search', options.baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Scrapy-API base URL must be HTTP(S) without credentials');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Scrapy-API timeout');
  return async (query, queryType = 'name') => {
    const q = query.trim();
    if (!q) return [];
    if (q.length > 200) throw new AppError(400, 'BAD_REQUEST', 'Search query exceeds 200 characters');
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ q, queryType, limitPerChain: '10' }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        signal: controller.signal, headers: { accept: 'application/json' }, redirect: 'error',
      });
      if (!response.ok) {
        throw new ScrapyApiError('http', response.status,
          retryAfter(response.headers.get('retry-after')), response.headers.get('x-request-id') ?? undefined);
      }
      const body: unknown = await response.json();
      const parsed = z.array(productSchema).safeParse(body);
      if (!parsed.success) throw new ScrapyApiError('response');
      return parsed.data;
    } catch (error) {
      if (error instanceof ScrapyApiError) throw error;
      throw new ScrapyApiError(controller.signal.aborted ? 'timeout' :
        error instanceof SyntaxError ? 'response' : 'network');
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
  };
}

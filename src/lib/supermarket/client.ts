import { gunzipSync } from 'node:zlib';

const REQUEST_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

let lastRequestTime = 0;

async function rateLimitedWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const waitMs = REQUEST_INTERVAL_MS - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();
}

export async function fetchWithRateLimit(url: string, options: RequestInit = {}): Promise<Response> {
  await rateLimitedWait();

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      if (attempt > 0) {
        await rateLimitedWait();
      }

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'neuton-supermarket-prices/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
          ...options.headers,
        },
      });

      clearTimeout(timeout);

      if (!response.ok && response.status >= 500 && attempt < MAX_RETRIES) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES) {
        continue;
      }
    }
  }

  throw lastError ?? new Error('Request failed after retries');
}

/** Read a response body, transparently unzipping .gz price files. */
async function decodeBody(response: Response, what: string): Promise<string> {
  const declared = parseInt(response.headers.get('content-length') || '0', 10);
  if (declared > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large: ${declared} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Response too large: ${buffer.byteLength} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`,
    );
  }
  let decompressed = buffer;
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      decompressed = gunzipSync(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to decompress gzip for ${what}: ${msg}`);
    }
    if (decompressed.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error(
        `Decompressed response too large for ${what}: ${decompressed.byteLength} bytes exceeds ${MAX_RESPONSE_SIZE} byte limit`,
      );
    }
  }
  const text = decompressed.toString('utf8');
  return text;
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetchWithRateLimit(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return decodeBody(res, url);
}

export async function fetchXml(url: string): Promise<string> {
  const xml = await fetchText(url);
  const trimmed = xml.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    return xml;
  }
  throw new Error(`Response does not appear to be XML from ${url}`);
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

export function extractHtmlBlocks(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[1] ?? '';
    out.push(v);
  }
  return out;
}

export function extractXmlBlocks(xml: string, tag: string, fields?: string[]): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let block = m[1] ?? '';
    if (fields && fields.length > 0) {
      const keep: string[] = [];
      for (const f of fields) {
        if (new RegExp(`<${f}\\b`, 'i').test(block)) {
          keep.push(f);
        }
      }
      if (keep.length === 0) {
        out.push(block);
        continue;
      }
      const wrapped = keep
        .map((f) => extractXmlElements(block, f).map((v) => `<${f}>${v}</${f}>`).join(''))
        .join('');
      block = wrapped ? `<${tag}>${wrapped}</${tag}>` : block;
    }
    out.push(block);
  }
  return out;
}

export function extractXmlElements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const v = m[1]?.trim() ?? '';
    out.push(v);
  }
  return out;
}

export function extractXmlElement(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(xml);
  return m?.[1]?.trim() ?? null;
}

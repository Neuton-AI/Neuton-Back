import { gunzipSync } from 'node:zlib';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

/** Keep the deadline and retries active until the body has been read. */
async function fetchWithRetries(url: string): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let retryable = true;
    const timeout = setTimeout(() => controller.abort(
      new Error(`Supermarket request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`),
    ), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'neuton-supermarket-prices/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
        },
      });

      if (!response.ok) {
        retryable = response.status >= 500;
        await response.body?.cancel();
        const error = new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        throw error;
      } else {
        return await decodeBody(response, url);
      }
    } catch (err) {
      if (!retryable) throw err;
      // Reading an aborted response body may throw a generic AbortError.
      lastError = controller.signal.aborted ? controller.signal.reason
        : err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Supermarket request failed after ${MAX_RETRIES + 1} attempts for ${url}: ${lastError?.message}`, {
    cause: lastError,
  });
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
  return fetchWithRetries(url);
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

export function extractXmlBlocks(xml: string, tag: string, fields?: readonly string[]): string[] {
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

import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { XMLValidator } from 'fast-xml-parser';

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
// Both src/lib/supermarket and dist/lib/supermarket are three levels below root.
export const CATALOG_DIRECTORY = fileURLToPath(new URL('../../../prices/', import.meta.url));

interface CacheOptions<T> {
  directory?: string;
  now?: () => number;
  download: (chain: string) => Promise<string>;
  parse: (xml: string) => T[];
}

/** One instance per process; the filesystem lock also serializes separate workers. */
export function createCatalogCache<T>(options: CacheOptions<T>) {
  const directory = options.directory ?? CATALOG_DIRECTORY;
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<T[]>>();
  const parsed = new Map<string, { signature: string; items: T[] }>();

  function parse(xml: string): T[] {
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw new Error(`Invalid catalog XML: ${valid.err.msg}`);
    const items = options.parse(xml);
    if (items.length === 0) throw new Error('Catalog contains no price items');
    return items;
  }

  async function load(chain: string): Promise<T[]> {
    const folder = join(directory, chain);
    await mkdir(folder, { recursive: true });
    let compromised: Error | undefined;
    const release = await lockfile.lock(folder, {
      stale: 120_000,
      update: 10_000,
      retries: { retries: 3000, minTimeout: 100, maxTimeout: 500, factor: 1 },
      onCompromised: (error) => { compromised = error; },
    });
    try {
      const files = (await readdir(folder)).sort().reverse();
      let cached: T[] | undefined;
      for (const name of files) {
        const path = join(folder, name);
        const timestamp = /^\d+\.xml$/.test(name) ? Number(name.slice(0, -4)) : NaN;
        const age = now() - timestamp;
        if (!cached && Number.isSafeInteger(timestamp) && age >= 0 && age < CATALOG_TTL_MS) {
          try {
            const info = await stat(path);
            await access(path, constants.R_OK);
            const signature = `${name}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
            const memory = parsed.get(chain);
            cached = memory?.signature === signature ? memory.items : parse(await readFile(path, 'utf8'));
            parsed.set(chain, { signature, items: cached });
            continue;
          } catch {
            // Remove unreadable/invalid catalogs before attempting recovery.
          }
        }
        await rm(path, { force: true });
      }
      if (compromised) throw compromised;
      if (cached) return cached;
      parsed.delete(chain);
      const xml = await options.download(chain);
      const downloadedAt = now();
      const items = parse(xml);
      const temporary = join(folder, `${randomUUID()}.tmp`);
      const completed = join(folder, `${downloadedAt}.xml`);
      try {
        await writeFile(temporary, xml, { encoding: 'utf8', flag: 'wx' });
        if (compromised) throw compromised;
        await rename(temporary, completed);
        const info = await stat(completed);
        parsed.set(chain, {
          signature: `${downloadedAt}.xml:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
          items,
        });
        return items;
      } finally {
        await rm(temporary, { force: true });
      }
    } catch (cause) {
      parsed.delete(chain);
      throw new Error(`Catalog cache for ${chain} at ${folder} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    } finally {
      await release();
    }
  }

  return {
    get(chain: string): Promise<T[]> {
      if (!/^[a-z]+$/.test(chain)) return Promise.reject(new Error('Invalid catalog chain'));
      const existing = pending.get(chain);
      if (existing) return existing;
      const operation = load(chain).finally(() => pending.delete(chain));
      pending.set(chain, operation);
      return operation;
    },
  };
}

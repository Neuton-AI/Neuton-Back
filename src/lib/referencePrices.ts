import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../db/types.js';
import type { NewGeneralPrice } from '../db/schema/catalog.js';
import { queryRows } from '../db/query-rows.js';
import { z } from 'zod';

/** SQL checks the app shop role or persisted worker authorization before writing. */
export async function upsertReferencePrice(database: Pick<DatabaseTransaction, 'execute'>, price: NewGeneralPrice): Promise<string> {
  const rows = await queryRows(database, sql`select app_private.upsert_general_price(
    ${price.rawName}::text,${price.sku ?? null}::text,${price.rawMaterialName}::text,
    ${price.rawSrcUnit ?? null}::text,${price.srcUnit ?? null}::text,${price.baseUnit ?? null}::text,
    ${price.baseUnitAmount ?? null}::numeric,${price.baseUnitCost ?? null}::numeric) as id`, z.object({ id: z.string() }));
  if (!rows[0]?.id) throw new Error('Reference price write returned no row');
  return rows[0].id;
}

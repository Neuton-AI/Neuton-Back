import type { SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';

export interface SqlExecutor { execute(query: SQL): PromiseLike<unknown> }
export async function queryRows<S extends z.ZodTypeAny>(transaction: SqlExecutor, query: SQL, schema: S): Promise<z.infer<S>[]> {
  const result = await transaction.execute(query);
  let rows: unknown = result;
  if (result && typeof result === 'object' && 'rows' in result) rows = result.rows;
  const parsed = schema.array().safeParse(rows);
  if (!parsed.success) throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database temporarily unavailable');
  return parsed.data;
}

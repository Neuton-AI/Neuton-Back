import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { assertVerifiedSession } from '../modules/identity/verified-session.js';
import type { VerifiedSessionReference } from '../modules/identity/verified-session.js';
import type { ShopTransaction, UserTransaction } from './types.js';

interface ContextTransaction { execute(query: SQL): PromiseLike<unknown> }
interface TransactionBoundary<T extends ContextTransaction> {
  transaction<R>(work: (transaction: T) => Promise<R>): Promise<R>;
}

function authorizationRow(result: unknown): Record<string, unknown> {
  let rows: unknown = result;
  if (result && typeof result === 'object' && 'rows' in result) rows = result.rows;
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') {
    throw new AppError(503, 'AUTHORIZATION_UNAVAILABLE', 'Unable to establish current access');
  }
  return rows[0];
}

async function setContext(transaction: ContextTransaction, session: VerifiedSessionReference, shopId: string): Promise<void> {
  try {
    await transaction.execute(sql`select set_config('neuton.user_id',${session.userId},true),
      set_config('neuton.session_id',${session.sessionId},true),set_config('neuton.shop_id',${shopId},true),
      set_config('neuton.job_id','',true)`);
  } catch {
    throw new AppError(503, 'AUTHORIZATION_UNAVAILABLE', 'Unable to establish current access');
  }
}

async function inBoundary<T extends ContextTransaction, R>(
  database: TransactionBoundary<T>, work: (transaction: T) => Promise<R>,
): Promise<R> {
  try {
    return await database.transaction(work);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' &&
      /^(08|53|57P0|57014|40001|40P01|CONNECTION_|ECONN|ENET|EHOST|EPIPE|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/.test(error.code)) {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is temporarily unavailable');
    }
    throw error;
  }
}

export async function withUserTransaction<T extends ContextTransaction, R>(
  database: TransactionBoundary<T>, session: VerifiedSessionReference,
  work: (scope: UserTransaction<T>) => Promise<R>,
): Promise<R> {
  assertVerifiedSession(session);
  return inBoundary(database, async transaction => {
    await setContext(transaction, session, '');
    let result: unknown;
    try {
      result = await transaction.execute(sql`select app_private.lock_user_context() as valid`);
    } catch {
      throw new AppError(503, 'AUTHORIZATION_UNAVAILABLE', 'Unable to establish current access');
    }
    if (authorizationRow(result).valid !== true) throw unauthorized('Active session required');
    return work(Object.freeze({ scope: 'user', database: transaction, userId: session.userId, sessionId: session.sessionId }));
  });
}

export async function withShopTransaction<T extends ContextTransaction, R>(
  database: TransactionBoundary<T>, session: VerifiedSessionReference, shopId: string,
  work: (scope: ShopTransaction<T>) => Promise<R>,
): Promise<R> {
  assertVerifiedSession(session);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId)) throw forbidden('Invalid shop selection');
  return inBoundary(database, async transaction => {
    await setContext(transaction, session, shopId);
    let result: unknown;
    try {
      result = await transaction.execute(sql`select app_private.lock_shop_context() as role`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '28000') {
        throw unauthorized('Active session required');
      }
      throw new AppError(503, 'AUTHORIZATION_UNAVAILABLE', 'Unable to establish current access');
    }
    const role = authorizationRow(result).role;
    if (role !== 'owner' && role !== 'admin' && role !== 'member') throw forbidden('Shop access unavailable');
    return work(Object.freeze({ scope: 'shop', database: transaction, userId: session.userId, sessionId: session.sessionId, shopId, role }));
  });
}

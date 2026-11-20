import { getDatabaseErrorCode } from './dbErrors.js';

/** Retry only server-confirmed rollback; never replay an ambiguous commit. */
export async function retryTransaction<T>(operation: () => Promise<T>): Promise<T> {
  let attempts = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempts++;
      const code = getDatabaseErrorCode(error);
      if (attempts >= 12 || (code !== '40001' && code !== '40P01')) {
        throw error;
      }
    }
  }
}

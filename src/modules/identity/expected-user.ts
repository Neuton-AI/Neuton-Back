import { AppError, badRequest } from '../../lib/errors.js';

/** A client may restrict an operation to its original account; this header never grants authority. */
export function assertExpectedUser(expected: string | string[] | undefined, actualUserId: string): void {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected)) {
    throw badRequest('Invalid account precondition');
  }
  if (expected.toLowerCase() !== actualUserId.toLowerCase()) throw new AppError(409, 'ACCOUNT_CHANGED', 'Account changed; reload your session before continuing');
}

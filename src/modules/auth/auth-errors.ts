import { isTransientDatabaseError } from '../../lib/dbErrors.js';
import { AppError } from '../../lib/errors.js';
import { ZodError } from 'zod';

export const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
export const invalidAction = () => new AppError(400, 'INVALID_ACTION', 'This link is invalid or has expired');
export const authUnavailable = () => new AppError(503, 'AUTH_UNAVAILABLE', 'Authentication temporarily unavailable');

/** Preserve deliberate domain/validation outcomes; never attach provider or SQL errors as public details. */
export function mapAuthDependencyError(error: unknown): unknown {
  if (error instanceof AppError || error instanceof ZodError) return error;
  if (isTransientDatabaseError(error)) return authUnavailable();
  let candidate = error;
  for (let depth = 0; candidate && typeof candidate === 'object' && depth < 5; depth += 1) {
    if ('code' in candidate && typeof candidate.code === 'string' && /^(53\d{3}|57014)$/.test(candidate.code)) {
      return authUnavailable();
    }
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return error;
}

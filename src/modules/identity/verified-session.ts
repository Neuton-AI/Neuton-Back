import { unauthorized } from '../../lib/errors.js';

const verifiedReference: unique symbol = Symbol('VerifiedSessionReference');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface VerifiedSessionReference {
  readonly [verifiedReference]: true;
  readonly userId: string;
  readonly sessionId: string;
}

/** Identity/session resolution calls this only after establishing cookie proof. */
export function referenceVerifiedSession(userId: string, sessionId: string): VerifiedSessionReference {
  if (!uuid.test(userId) || !uuid.test(sessionId)) throw unauthorized('Invalid session reference');
  return Object.freeze({ [verifiedReference]: true as const, userId, sessionId });
}

export function assertVerifiedSession(reference: VerifiedSessionReference): void {
  if (!reference || reference[verifiedReference] !== true) throw unauthorized('Verified session required');
}

import type { ShopRole } from '../../db/schema/enums.js';
import { forbidden } from '../../lib/errors.js';
import type { ActorContext } from './contracts.js';

/** Call in the use case so every entry point enforces the same policy. */
export function requireActorRole(actor: ActorContext, allowedRoles: readonly ShopRole[]): void {
  if (!allowedRoles.includes(actor.role)) {
    throw forbidden(`Requires one of the roles: ${allowedRoles.join(', ')}`);
  }
}

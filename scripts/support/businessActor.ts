import './testEnv.js';
import type { DatabaseTransaction, ShopTransaction } from '../../src/db/types.js';
import type { ActorContext } from '../../src/modules/identity/contracts.js';
import { referenceVerifiedSession } from '../../src/modules/identity/verified-session.js';
import { actorFor } from './nestOrdersApp.js';

export function businessActor(shopId: string, userId: string): ActorContext {
  const actor = actorFor();
  return {
    ...actor, shop: { ...actor.shop, id: shopId }, user: { ...actor.user, id: userId },
    session: referenceVerifiedSession(userId, actor.sessionId)
  };
}

/** A capability for an outer transaction controlled by an isolated fixture. */
export function fixtureScope(database: DatabaseTransaction, actor: ActorContext): ShopTransaction {
  return {
    scope: 'shop', database, userId: actor.user.id, sessionId: actor.sessionId,
    shopId: actor.shop.id, role: actor.role
  };
}

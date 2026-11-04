import type { Database } from './client.js';
import type { DatabaseTransaction, ShopTransaction } from './types.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import { forbidden } from '../lib/errors.js';
import { withShopTransaction } from './tenant-context.js';

/** A pool opens a boundary; an existing capability keeps all work on its handle. */
export class ShopOperation {
  constructor(private readonly source: Database | ShopTransaction) {}

  get database(): DatabaseTransaction {
    if (!('scope' in this.source)) throw new Error('Shop transaction required');
    return this.source.database;
  }

  get scope(): ShopTransaction {
    if (!('scope' in this.source)) throw new Error('Shop transaction required');
    return this.source;
  }

  async run<T>(actor: ActorContext, work: (scope: ShopTransaction, actor: ActorContext) => Promise<T>): Promise<T> {
    const execute = async (scope: ShopTransaction) => {
      if (scope.userId !== actor.user.id || scope.sessionId !== actor.sessionId || scope.shopId !== actor.shop.id) {
        throw forbidden('Operation context does not match the verified actor');
      }
      return work(scope, { ...actor, role: scope.role });
    };
    if ('scope' in this.source) return execute(this.source);
    return withShopTransaction(this.source, actor.session, actor.shop.id, execute);
  }
}

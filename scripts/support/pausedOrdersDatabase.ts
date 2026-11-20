import type { Database } from '../../src/db/client.js';
import type { OrdersTransaction } from '../../src/modules/orders/orders.persistence.js';
import { shops } from '../../src/db/schema/index.js';

/** Test-only barrier just before invoice allocation, after every source read. */
export function pauseBeforeOrderWrite(database: Database) {
  let signalRead!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { signalRead = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  let attempts = 0;
  const pause = async () => {
    if (paused) return;
    paused = true;
    signalRead();
    await released;
  };
  const gate = (builder: object): object => new Proxy(builder, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === 'then' && typeof value === 'function') {
        return (...args: unknown[]) => pause().then(() => Reflect.apply(value, target, args));
      }
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result && typeof result === 'object' ? gate(result) : result;
        };
      }
      return value;
    },
  });
  const wrapped = new Proxy(database, {
    get(target, key) {
      if (key === 'transaction') {
        return (operation: (tx: OrdersTransaction) => Promise<unknown>, config?: Parameters<Database['transaction']>[1]) => {
          attempts++;
          return target.transaction(tx => operation(new Proxy(tx, {
            get(transaction, property) {
              const value = Reflect.get(transaction, property);
              if (property === 'update') {
                return (table: unknown) => {
                  const query = Reflect.apply(value, transaction, [table]);
                  if (table === shops && query && typeof query === 'object') {
                    return gate(query);
                  }
                  return query;
                };
              }
              return typeof value === 'function' ? value.bind(transaction) : value;
            },
          })), config);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { database: wrapped, reached, release, attempts: () => attempts };
}

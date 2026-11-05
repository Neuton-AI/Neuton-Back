export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Pause once after a real table SELECT; retain the actual transaction/role. */
export function observeSelect<T extends object>(database: T, table: object, onRows: () => Promise<void>): T {
  let observed = false;
  function query(target: object, match = false): object {
    return new Proxy(target, { get(object, key) {
      if (key === 'then') {
        return (resolve: (rows: unknown) => void, reject: (error: unknown) => void) => {
          Promise.resolve(object).then(async rows => {
            if (match && !observed) {
              observed = true;
              await onRows();
            }
            return rows;
          }).then(resolve, reject);
        };
      }
      const value = Reflect.get(object, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => query(value.apply(object, args), key === 'from' ? args[0] === table : match);
    } });
  }
  function wrap(target: object): object {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key);
      if (key === 'transaction') {
        return (work: (transaction: object) => Promise<unknown>) =>
          value.call(object, (transaction: object) => work(wrap(transaction)));
      }
      if (key === 'select') return (...args: unknown[]) => query(value.apply(object, args));
      return typeof value === 'function' ? value.bind(object) : value;
    } });
  }
  return wrap(database) as T;
}

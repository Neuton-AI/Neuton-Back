/** Application events contain no database/provider types or document payloads. */
export type SyncEvent = 'document-change' | 'reconcile' | 'unavailable';
export abstract class SyncEventSource {
  abstract ready(): Promise<void>;
  abstract close(): Promise<void>;
}

export class SyncEvents {
  private readonly shops = new Map<string, Set<(event: SyncEvent) => void>>();
  subscribe(shop: string, receive: (event: SyncEvent) => void) {
    const listeners = this.shops.get(shop) ?? new Set();
    this.shops.set(shop, listeners);
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
      if (!listeners.size) this.shops.delete(shop);
    };
  }
  changed(shop: string) {
    for (const receive of this.shops.get(shop) ?? [])
      receive('document-change');
  }
  recovered() {
    for (const listeners of this.shops.values())
      for (const receive of listeners) receive('reconcile');
  }
  unavailable() {
    for (const listeners of [...this.shops.values()])
      for (const receive of [...listeners]) receive('unavailable');
  }
}

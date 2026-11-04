import postgres from 'postgres';
import { databaseTransportOptions } from '../../db/connection.js';
import { SyncEventSource, type SyncEvents } from './sync-events.js';

/** Own session: never point this connection at a transaction pooler. */
export class PostgresSyncEvents extends SyncEventSource {
  private client?: postgres.Sql;
  private starting?: Promise<void>;
  private stopped = false;
  constructor(private readonly url: string, private readonly events: SyncEvents) { super(); }

  ready() {
    if (this.stopped) return Promise.reject(new Error('Sync listener stopped'));
    if (this.starting) return this.starting;
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.starting = undefined;
      this.events.unavailable();
      void client.end({ timeout: 1 }).catch(() => undefined);
    };
    const client = postgres(this.url, {
      ...databaseTransportOptions(),
      max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10,
      connection: { application_name: 'neuton-sync-listener' },
      onnotice: () => {},
      onclose: lost,
      onnotify: (channel, payload) => {
        if (this.client === client && channel === 'neuton_document_changes' && /^[0-9a-f-]{36}$/i.test(payload)) {
          this.events.changed(payload);
        }
      },
    });
    this.client = client;
    this.starting = (async () => {
      try {
        await client.unsafe('LISTEN neuton_document_changes');
        if (this.client !== client || this.stopped) {
          throw new Error('Sync listener disconnected');
        }
        this.events.recovered();
      } catch (error) { lost(); throw error; }
    })();
    return this.starting;
  }
  async close() {
    this.stopped = true;
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    this.events.unavailable();
    await client?.end({ timeout: 5 });
  }
  async onModuleDestroy() { await this.close(); }
}

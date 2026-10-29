import { Client } from 'pg';
import { SyncEventSource, type SyncEvents } from './sync-events.js';

/** Own session: never point this connection at a transaction pooler. */
export class PostgresSyncEvents extends SyncEventSource {
  private client?: Client;
  private starting?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly url: string,
    private readonly events: SyncEvents,
  ) {
    super();
  }
  ready() {
    if (this.stopped) return Promise.reject(new Error('Sync listener stopped'));
    if (this.starting) return this.starting;
    const client = new Client({
      connectionString: this.url,
      connectionTimeoutMillis: 10000,
      application_name: 'neuton-sync-listener',
      keepAlive: true,
    });
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.starting = undefined;
      this.events.unavailable();
      void client.end().catch(() => undefined);
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', ({ channel, payload }) => {
      if (
        channel === 'neuton_document_changes' &&
        payload &&
        /^[0-9a-f-]{36}$/i.test(payload)
      )
        this.events.changed(payload);
    });
    this.starting = (async () => {
      try {
        await client.connect();
        await client.query('LISTEN neuton_document_changes');
        if (this.client !== client || this.stopped)
          throw new Error('Sync listener disconnected');
        this.events.recovered();
      } catch (error) {
        lost();
        throw error;
      }
    })();
    return this.starting;
  }
  async close() {
    this.stopped = true;
    const client = this.client;
    this.client = undefined;
    this.starting = undefined;
    this.events.unavailable();
    await client?.end();
  }
  async onModuleDestroy() {
    await this.close();
  }
}

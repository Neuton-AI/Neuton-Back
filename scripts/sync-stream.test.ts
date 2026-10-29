import './support/testEnv.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { ShopGuard } from '../src/modules/identity/shop.guard.js';
import {
  SyncEvents,
  SyncEventSource,
} from '../src/modules/sync/sync-events.js';
import { SyncEventsController } from '../src/modules/sync/sync-events.controller.js';
import { testApplication } from './support/httpClient.js';
import { forbidden } from '../src/lib/errors.js';

@Module({
  controllers: [SyncEventsController],
  providers: [
    SyncEvents,
    ShopGuard,
    {
      provide: SyncEventSource,
      useValue: { ready: async () => {}, close: async () => {} },
    },
    { provide: IdentityService, useValue: {} },
  ],
})
class StreamFixture {}

test(
  'SSE authorizes the shop, delivers hints, and stops on membership revocation or source loss',
  { timeout: 10000 },
  async () => {
    let allowed = true;
    const app = await testApplication(StreamFixture, [
      [
        IdentityService,
        {
          resolve: async ({
            authorization,
            shopId,
          }: {
            authorization?: string;
            shopId?: string;
          }) => {
            if (
              !allowed ||
              authorization !== 'Bearer fixture' ||
              shopId !== 'shop-a'
            )
              throw forbidden('Access denied');
            return {
              user: { id: 'user-a' },
              shop: { id: 'shop-a' },
              role: 'owner',
            };
          },
        },
      ],
    ]);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/api/v1/sync/events`;
    const headers = { Authorization: 'Bearer fixture', 'x-shop-id': 'shop-a' };
    const abort = new AbortController();
    try {
      const denied = await fetch(url, {
        headers: { ...headers, 'x-shop-id': 'shop-b' },
      });
      assert.equal(denied.status, 403);
      const response = await fetch(url, { headers, signal: abort.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      const reader = response.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /event: reconcile/,
      );
      const events = app.get(SyncEvents);
      events.changed('shop-a');
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /event: reconcile/,
      );
      allowed = false;
      events.changed('shop-a');
      assert.equal((await reader.read()).done, true);
      allowed = true;
      const second = await fetch(url, { headers, signal: abort.signal });
      const other = second.body!.getReader();
      await other.read();
      events.unavailable();
      assert.equal((await other.read()).done, true);
    } finally {
      abort.abort();
      await app.close();
    }
  },
);

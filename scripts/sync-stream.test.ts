import './support/testEnv.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { ActorContext } from '../src/modules/identity/contracts.js';
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
  async (t) => {
    t.mock.method(Math, 'random', () => 0);
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

// Exercise connection timing without waiting for real heartbeats or using a database.
async function streamHarness(t: TestContext, enableTimers = true) {
  if (enableTimers) t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const frames: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    set() {},
    flushHeaders() {},
    write(frame: string): boolean {
      frames.push(frame);
      return true;
    },
    end: t.mock.fn(),
  });
  const resolve = t.mock.fn(async () => ({}));
  const events = new SyncEvents();
  const controller = new SyncEventsController(
    events,
    { ready: async () => {}, close: async () => {} },
    { resolve } as unknown as IdentityService,
  );
  await controller.stream(
    { shop: { id: 'shop-a' } } as ActorContext,
    { headers: { authorization: 'Bearer fixture' } } as Request,
    response as unknown as Response,
  );
  t.after(() => response.emit('close'));
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { frames, response, resolve, events, tick };
}

test('idle heartbeats skip identity checks and cannot flush a jittered hint early', async (t) => {
  t.mock.method(Math, 'random', () => 0.999999);
  const h = await streamHarness(t);
  assert.equal(h.resolve.mock.callCount(), 1);
  await h.tick(14000);
  h.events.changed('shop-a');
  await h.tick(1000); // Heartbeat during the 4.249 second change window.
  assert.deepEqual(h.frames, ['event: reconcile\ndata: {}\n\n', ': heartbeat\n\n']);
  assert.equal(h.resolve.mock.callCount(), 1);
  h.events.changed('shop-a'); // Does not restart the existing timer.
  await h.tick(3248);
  assert.equal(h.frames.length, 2);
  await h.tick(2);
  assert.equal(h.frames.length, 3);
  assert.equal(h.resolve.mock.callCount(), 2);
  await h.tick(11750);
  assert.equal(h.frames.at(-1), ': heartbeat\n\n');
  assert.equal(h.resolve.mock.callCount(), 2);
});

test('minimum batching is 250 ms and a hint during authorization gets a trailing send', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await streamHarness(t);
  let release!: () => void;
  h.resolve.mock.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({});
  }));
  h.events.changed('shop-a');
  await h.tick(249);
  assert.equal(h.resolve.mock.callCount(), 1);
  await h.tick(1);
  assert.equal(h.resolve.mock.callCount(), 2);
  h.events.changed('shop-a');
  release();
  await h.tick(0);
  assert.equal(h.frames.length, 2);
  await h.tick(250);
  assert.equal(h.frames.length, 3);
});

test('revocation blocks recovery hints, and disconnect cancels all pending work', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await streamHarness(t);
  h.resolve.mock.mockImplementation(async () => {
    throw forbidden('Revoked');
  });
  h.events.recovered();
  await h.tick(250);
  assert.equal(h.frames.length, 1);
  assert.equal(h.response.end.mock.callCount(), 1);
  await h.tick(60000);
  assert.equal(h.frames.length, 1);
});

test('disconnect detaches listeners and cancels delayed hints', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  const h = await streamHarness(t);
  h.events.changed('shop-a');
  h.response.emit('close');
  await h.tick(60000);
  assert.equal(h.frames.length, 1);
  assert.equal(h.resolve.mock.callCount(), 1);
  assert.equal(h.response.end.mock.callCount(), 1);
});

test('slow heartbeat clients are closed without another identity check', async (t) => {
  const h = await streamHarness(t);
  h.response.write = () => false;
  await h.tick(15000);
  assert.equal(h.response.end.mock.callCount(), 1);
  assert.equal(h.resolve.mock.callCount(), 1);
  h.events.changed('shop-a');
  await h.tick(60000);
  assert.equal(h.resolve.mock.callCount(), 1);
});

test('separate connections independently sample jitter for each new batch', async (t) => {
  const a = await streamHarness(t);
  const b = await streamHarness(t, false);
  const samples = [0, 0.999999, 0.5];
  t.mock.method(Math, 'random', () => samples.shift() ?? 0.5);
  a.events.changed('shop-a');
  b.events.changed('shop-a');
  await a.tick(250);
  assert.equal(a.frames.length, 2);
  assert.equal(b.frames.length, 1);
  await a.tick(4000);
  assert.equal(b.frames.length, 2);
  a.events.changed('shop-a');
  await a.tick(2249);
  assert.equal(a.frames.length, 2);
  await a.tick(1);
  assert.equal(a.frames.length, 3);
});

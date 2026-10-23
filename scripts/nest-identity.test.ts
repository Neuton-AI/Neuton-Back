import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import request from 'supertest';
import { createHttpApplication } from '../src/http/application.js';
import { LoggerImpl } from '../src/lib/logger/index.js';
import { IdentityModule } from '../src/modules/identity/identity.module.js';
import { ShopGuard } from '../src/modules/identity/shop.guard.js';
import { CurrentActor } from '../src/modules/identity/current-actor.js';
import type { ActorContext, ShopContext } from '../src/modules/identity/contracts.js';
import { requireActorRole } from '../src/modules/identity/authorization.js';

const shop: ShopContext = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Kitchen', slug: 'kitchen', currency: 'ILS', timezone: 'Asia/Jerusalem',
  storeAddress: null, targetProfitMargin: '25', hourlyLaborCost: '0', deliveryBaseFee: '0', deliveryRatePerKm: '0',
};

@Controller('/identity-probe')
@UseGuards(ShopGuard)
class ProbeController {
  @Get() read(@CurrentActor() actor: ActorContext) {
    actor.log.info({ event: 'identity_probe' }, 'identity probe');
    return { user: actor.user, shop: actor.shop, role: actor.role, requestId: actor.requestId, traceId: actor.traceId, ipAddress: actor.ipAddress };
  }
  @Get('/admin') admin(@CurrentActor() actor: ActorContext) {
    requireActorRole(actor, ['owner', 'admin']);
    return { ok: true };
  }
}

async function fixture(options: { missingProfile?: boolean; missingShop?: boolean; databaseFailure?: boolean } = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const logger = new LoggerImpl({ write: (_level, _message, meta) => { logs.push(meta); } }, {}, 'debug');
  @Module({
    imports: [IdentityModule.register({
      sessionVerifier: {
        async verify(token: string) {
          calls.push(`verify:${token}`);
          return token === 'private-session-token' ? { id: 'user-a', email: 'private@example.test' } : null;
        },
      },
      repository: {
        async findProfile(userId: string) {
          calls.push(`profile:${userId}`);
          return options.missingProfile ? null : { fullName: 'Private Person', avatarUrl: null };
        },
        async findMembership(userId: string, shopId: string) {
          calls.push(`member:${userId}:${shopId}`);
          if (options.databaseFailure) throw new Error('private database credential and session-token');
          return userId === 'user-a' && shopId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ? { shopId, role: 'member' as const } : null;
        },
        async findShop(shopId: string) { calls.push(`shop:${shopId}`); return shopId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' && !options.missingShop ? shop : null; },
      },
    })],
    controllers: [ProbeController],
  })
  class ProbeModule {}
  const app = await createHttpApplication(ProbeModule, {
    origins: [], bodyLimit: 1024, rateLimit: { max: 100, windowMs: 60_000 }, logger,
  });
  return { app, calls, logs, server: app.getHttpServer() };
}

test('shop guard rejects missing and malformed credentials before external I/O', async () => {
  const { app, calls, server } = await fixture();
  try {
    for (const authorization of [undefined, 'Basic token', 'Bearer', 'Bearer token extra']) {
      const req = request(server).get('/identity-probe').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      if (authorization) req.set('Authorization', authorization);
      const response = await req;
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'UNAUTHORIZED');
      assert.ok(response.body.error.traceId);
    }
    assert.deepEqual(calls, []);
  } finally { await app.close(); }
});

test('shop guard rejects expired sessions, missing shops and foreign shops without fallback', async () => {
  const { app, calls, server } = await fixture();
  try {
    const invalid = await request(server).get('/identity-probe').set('Authorization', 'Bearer expired').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(invalid.status, 401);
    assert.deepEqual(calls, ['verify:expired']);
    const missing = await request(server).get('/identity-probe').set('Authorization', 'Bearer private-session-token');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'MISSING_SHOP_ID');
    const foreign = await request(server).get('/identity-probe').set('Authorization', 'Bearer private-session-token').set('x-shop-id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'FORBIDDEN');
    assert.ok(!calls.includes('shop:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    assert.ok(!JSON.stringify(foreign.body).includes('Kitchen'));
  } finally { await app.close(); }
});

test('valid membership provides actor correlation and enriches safe logs without leaking across requests', async () => {
  const { app, server, logs } = await fixture();
  try {
    const response = await request(server).get('/identity-probe')
      .set('Authorization', 'bEaReR private-session-token').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').set('X-Trace-Id', 'identity-trace');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.user, { id: 'user-a', email: 'private@example.test', fullName: 'Private Person', avatarUrl: null });
    assert.deepEqual(response.body.shop, shop);
    assert.equal(response.body.role, 'member');
    assert.equal(response.body.traceId, 'identity-trace');
    assert.ok(response.body.requestId);
    assert.ok(response.body.ipAddress);
    const probeLog = logs.find(line => line.event === 'identity_probe');
    assert.equal(probeLog?.userId, 'user-a');
    assert.equal(probeLog?.shopId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(probeLog?.traceId, 'identity-trace');
    const failed = await request(server).get('/identity-probe').set('X-Trace-Id', 'unauthenticated-trace');
    assert.equal(failed.status, 401);
    const failedLog = logs.find(line => line.event === 'http_request_completed' && line.traceId === 'unauthenticated-trace');
    assert.equal(failedLog?.userId, undefined);
    assert.equal(failedLog?.shopId, undefined);
    const serialized = JSON.stringify(logs);
    for (const secret of ['private-session-token', 'private@example.test', 'Private Person']) assert.ok(!serialized.includes(secret));
  } finally { await app.close(); }
});

test('service role policy rejects members independently of controller metadata', async () => {
  const { app, server } = await fixture();
  try {
    const response = await request(server).get('/identity-probe/admin')
      .set('Authorization', 'Bearer private-session-token').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'FORBIDDEN');
  } finally { await app.close(); }
});

test('missing profiles remain nullable and orphaned memberships cannot create an actor', async () => {
  const missingProfile = await fixture({ missingProfile: true });
  try {
    const response = await request(missingProfile.server).get('/identity-probe')
      .set('Authorization', 'Bearer private-session-token').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(response.status, 200);
    assert.equal(response.body.user.fullName, null);
    assert.equal(response.body.user.avatarUrl, null);
  } finally { await missingProfile.app.close(); }
  const missingShop = await fixture({ missingShop: true });
  try {
    const response = await request(missingShop.server).get('/identity-probe')
      .set('Authorization', 'Bearer private-session-token').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.message, 'Shop not found');
    assert.ok(!missingShop.logs.some(line => line.event === 'identity_probe'));
  } finally { await missingShop.app.close(); }
});

test('identity dependency failures preserve generic error responses and safe diagnostics', async () => {
  const { app, server, logs } = await fixture({ databaseFailure: true });
  try {
    const response = await request(server).get('/identity-probe')
      .set('Authorization', 'Bearer private-session-token').set('x-shop-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').set('X-Trace-Id', 'identity-failure');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', traceId: 'identity-failure' } });
    assert.ok(logs.some(line => line.event === 'http_request_failed' && line.traceId === 'identity-failure'));
    for (const secret of ['private-session-token', 'private database credential', 'private@example.test']) {
      assert.ok(!JSON.stringify(logs).includes(secret));
    }
  } finally { await app.close(); }
});

test('malformed shop ids fail as client input before persistence', async () => {
  const { app, calls, server } = await fixture();
  try {
    for (const shopId of ['not-a-uuid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']) {
      const response = await request(server).get('/identity-probe')
        .set('Authorization', 'Bearer private-session-token').set('x-shop-id', shopId);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'BAD_REQUEST');
    }
    assert.ok(calls.every(call => call === 'verify:private-session-token'));
  } finally { await app.close(); }
});

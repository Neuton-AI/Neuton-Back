import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { hashPassword } from '../src/modules/identity/password-hash.js';
import { RedisSignInLimiter, type SignInLimiter } from '../src/modules/identity/signin-limiter.js';

const redisUrl = process.env.NEUTON_TEST_REDIS_URL;
const origin = 'https://signin-limit.example.test';
process.env.APP_ORIGIN = origin;

test('sign-in shares limits across two HTTP apps and fails closed before credential lookup', {
  skip: !redisUrl && 'set NEUTON_TEST_REDIS_URL to an isolated loopback Redis instance',
  timeout: 30_000,
}, async (t) => {
  const url = new URL(redisUrl!);
  assert.equal(url.protocol, 'redis:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port);
  const namespace = `test-${randomUUID()}`;
  const prefix = `neuton:auth:{signin:v1:${namespace}}`;
  const options = { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 1000 };
  const redis = [new Redis(redisUrl!, options), new Redis(redisUrl!, options)] as const;
  t.after(async () => {
    try {
      if (redis[0].status === 'ready') {
        // The test owns this isolated namespace.
        const keys = await redis[0].keys(`${prefix}:*`);
        if (keys.length) await redis[0].del(...keys);
      }
    } finally {
      for (const client of redis) client.disconnect();
    }
  });
  await Promise.all(redis.map((client) => client.connect()));
  const { AuthController } = await import('../src/modules/identity/auth.controller.js');
  const { AuthService } = await import('../src/modules/identity/auth.service.js');
  const { SessionService } = await import('../src/modules/identity/session.service.js');
  const { GoogleFlowService } = await import('../src/modules/identity/google-flow.service.js');
  const { csrfProof } = await import('../src/modules/identity/session-http.js');
  const { testApplication } = await import('./support/httpClient.js');
  const password = 'known valid password';
  const account = {
    id: randomUUID(), email: 'known@example.test', fullName: null, avatarUrl: null, securityVersion: 0,
    passwordHash: await hashPassword(password),
  };
  const session = { idleExpiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) };
  let lookups = 0;
  let accountExists = true;
  const db = {
    select: () => ({ from: () => ({ where: async () => {
      lookups++;
      return accountExists ? [account] : [];
    } }) }),
  } as unknown as ConstructorParameters<typeof AuthService>[0];
  const sessions = {
    contextExists: async () => true,
    withStore: (work: () => Promise<unknown>) => work(),
    issue: async () => ({ secret: 'test-session', session }),
  } as unknown as InstanceType<typeof SessionService>;
  @Module({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: null },
      { provide: SessionService, useValue: null },
      { provide: GoogleFlowService, useValue: null },
    ],
  })
  class SignInProbeModule {}

  async function createApp(limiter: SignInLimiter, trustProxy?: string[]) {
    const app = await testApplication(SignInProbeModule, [
      [AuthService, new AuthService(db, sessions, limiter)],
      [SessionService, sessions],
    ], { origins: [origin], trustProxy });
    t.after(() => app.close());
    return request(app.getHttpServer());
  }
  const secret = 'test-sign-in-limiter-secret';
  const [first, second] = await Promise.all([
    createApp(new RedisSignInLimiter(redis[0], namespace, secret), ['loopback']),
    createApp(new RedisSignInLimiter(redis[1], namespace, secret), ['loopback']),
  ]);
  const context = 'test-context';
  const headers = { Origin: origin, Cookie: `__Host-neuton-context=${context}`, 'X-CSRF-Token': csrfProof(context, 'context') };
  const signIn = (api: typeof first, email: string, ip: string, candidate = 'wrong password') =>
    api.post('/api/v1/auth/signin').set(headers).set('X-Forwarded-For', ip).send({ email, password: candidate });
  const knownFailure = await signIn(first!, 'account@example.test', '192.0.2.1').expect(401);
  accountExists = false;
  const unknownFailure = await signIn(second!, ' ACCOUNT@example.test ', '192.0.2.2').expect(401);
  assert.equal(unknownFailure.body.error.message, knownFailure.body.error.message);
  accountExists = true;
  for (let index = 3; index <= 10; index++) {
    await signIn(first!, 'account@example.test', `192.0.2.${index}`).expect(401);
  }
  const beforeDenial = lookups;
  await signIn(second!, 'account@example.test', '192.0.2.11', password).expect(429);
  assert.equal(lookups, beforeDenial);

  const ip = '198.51.100.9';
  await signIn(second!, account.email, ip, password).expect(200);
  for (let index = 1; index < 60; index++) {
    await signIn(first!, `ip-test-${index}@example.test`, ip).expect(401);
  }
  const beforeIpDenial = lookups;
  await signIn(second, 'new-account@example.test', `::ffff:${ip}`).expect(429);
  assert.equal(lookups, beforeIpDenial);

  const noProxy = await createApp(new RedisSignInLimiter(redis[0], namespace, secret), ['203.0.113.77']);
  await signIn(noProxy, 'untrusted-header@example.test', ip).expect(401);
  assert.equal(await redis[0].zcard(`${prefix}:ip:${ip}`), 60);

  const unavailable = await createApp({ reserve: async () => { throw new Error('private connection detail'); } }, ['loopback']);
  const beforeUnavailable = lookups;
  const failed = await signIn(unavailable, 'new-account@example.test', ip).expect(503);
  assert.equal(failed.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.ok(!failed.text.includes('private connection detail'));
  assert.equal(lookups, beforeUnavailable);
});

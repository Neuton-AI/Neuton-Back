import './support/testEnv.js';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { RedisSignInLimiter } from '../src/modules/identity/signin-limiter.js';

const redisUrl = process.env.NEUTON_TEST_REDIS_URL;
const secret = 'test-sign-in-limiter-key';
const email = 'account@example.test';
const ip = '192.0.2.1';
const windowMs = 300_000;

test('sign-in windows are shared, expire, and release only successful account attempts', {
  skip: !redisUrl && 'set NEUTON_TEST_REDIS_URL to an isolated loopback Redis instance',
  timeout: 10_000,
}, async (t) => {
  const url = new URL(redisUrl!);
  assert.equal(url.protocol, 'redis:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port, 'Specify the isolated Redis port explicitly');
  const namespace = `test-${randomUUID()}`;
  const keyPrefix = `neuton:auth:{signin:v1:${namespace}}`;
  const accountDigest = createHmac('sha256', secret).update(email).digest('hex');
  const accountKey = `${keyPrefix}:account:${accountDigest}`;
  const ipKey = `${keyPrefix}:ip:${ip}`;
  const options = {
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 1000,
    lazyConnect: true,
  };
  const firstClient = new Redis(redisUrl!, options);
  const secondClient = new Redis(redisUrl!, options);
  t.after(async () => {
    try {
      if (firstClient.status === 'ready') {
        let cursor = '0';
        const keys: string[] = [];
        do {
          const [nextCursor, batch] = await firstClient.scan(cursor, 'MATCH', `${keyPrefix}:*`);
          cursor = nextCursor;
          keys.push(...batch);
        } while (cursor !== '0');
        if (keys.length) await firstClient.del(...keys);
      }
    } finally {
      firstClient.disconnect();
      secondClient.disconnect();
    }
  });
  await Promise.all([firstClient.connect(), secondClient.connect()]);
  const first = new RedisSignInLimiter(firstClient, namespace, secret);
  const second = new RedisSignInLimiter(secondClient, namespace, secret);

  for (let index = 1; index <= 9; index++) {
    assert.ok(await first.reserve(email, `198.51.100.${index}`));
  }
  const contested = await Promise.all([first.reserve(email, ip), second.reserve(email, ip)]);
  assert.equal(contested.filter(Boolean).length, 1);
  const winningAttempt = contested.find((attempt) => attempt !== null);
  assert.ok(winningAttempt);
  assert.equal(await firstClient.zcard(accountKey), 10);
  assert.equal(await firstClient.zcard(ipKey), 1);
  for (const key of [accountKey, ipKey]) {
    const ttl = await firstClient.pttl(key);
    assert.ok(ttl > 0 && ttl <= windowMs);
    await firstClient.pexpire(key, windowMs - 10_000);
  }
  assert.equal(await second.reserve(email, ip), null);
  assert.ok(await firstClient.pttl(accountKey) <= windowMs - 10_000);
  assert.ok(await firstClient.pttl(ipKey) <= windowMs - 10_000);
  assert.equal(await firstClient.zcard(ipKey), 1);

  await winningAttempt.releaseAccount();
  assert.equal(await firstClient.zcard(accountKey), 9);
  assert.equal(await firstClient.zcard(ipKey), 1);
  assert.ok(await second.reserve(email, ip));

  const [seconds, microseconds] = await firstClient.time();
  const now = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  const [oldMember, recentMember] = await firstClient.zrange(accountKey, 0, 1);
  assert.ok(oldMember && recentMember);
  await firstClient.zadd(accountKey, now - windowMs, oldMember, now - windowMs + 10_000, recentMember);
  assert.ok(await second.reserve(email, ip));
  assert.equal(await firstClient.zscore(accountKey, oldMember), null);
  assert.notEqual(await firstClient.zscore(accountKey, recentMember), null);

  for (let index = 3; index < 59; index++) {
    assert.ok(await first.reserve(`other-${index}@example.test`, ip));
  }
  const ipContest = await Promise.all([
    first.reserve('last-first@example.test', ip),
    second.reserve('last-second@example.test', ip),
  ]);
  assert.equal(ipContest.filter(Boolean).length, 1);
  assert.equal(await firstClient.zcard(ipKey), 60);
  const deniedEmail = 'another@example.test';
  assert.equal(await second.reserve(deniedEmail, ip), null);
  const deniedDigest = createHmac('sha256', secret).update(deniedEmail).digest('hex');
  assert.equal(await firstClient.exists(`${keyPrefix}:account:${deniedDigest}`), 0);
  assert.equal(await firstClient.zcard(ipKey), 60);
});

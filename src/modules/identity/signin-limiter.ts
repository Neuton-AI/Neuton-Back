import { createHmac, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const windowMs = 300_000;
const accountLimit = 10;
const ipLimit = 60;

// Redis serializes the window check and both reservations across API instances.
const reserveAttempt = `
local accountKey = KEYS[1]
local ipKey = KEYS[2]
local attemptId = ARGV[1]
local windowMs = tonumber(ARGV[2])
local accountLimit = tonumber(ARGV[3])
local ipLimit = tonumber(ARGV[4])

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cutoff = now - windowMs
redis.call('ZREMRANGEBYSCORE', accountKey, '-inf', cutoff)
redis.call('ZREMRANGEBYSCORE', ipKey, '-inf', cutoff)

if redis.call('ZCARD', accountKey) >= accountLimit or redis.call('ZCARD', ipKey) >= ipLimit then
  return 0
end

redis.call('ZADD', accountKey, now, attemptId)
redis.call('ZADD', ipKey, now, attemptId)
redis.call('PEXPIRE', accountKey, windowMs)
redis.call('PEXPIRE', ipKey, windowMs)
return 1
`;

export interface SignInReservation {
  releaseAccount(): Promise<void>;
}

export interface SignInLimiter {
  reserve(normalizedEmail: string, sourceIp: string): Promise<SignInReservation | null>;
}

export class RedisSignInLimiter implements SignInLimiter {
  private readonly keyPrefix: string;

  // The client must not resend an admission whose outcome is unknown.
  constructor(
    private readonly redis: Pick<Redis, 'eval' | 'zrem'>,
    namespace: string,
    private readonly accountKeySecret: string,
  ) {
    // The shared hash tag keeps both keys in one slot on clustered Redis.
    this.keyPrefix = `neuton:auth:{signin:v1:${namespace}}`;
  }

  async reserve(normalizedEmail: string, sourceIp: string): Promise<SignInReservation | null> {
    const digest = createHmac('sha256', this.accountKeySecret).update(normalizedEmail).digest('hex');
    const accountKey = `${this.keyPrefix}:account:${digest}`;
    const ipKey = `${this.keyPrefix}:ip:${sourceIp}`;
    const attemptId = randomUUID();
    const result = await this.redis.eval(reserveAttempt, 2, accountKey, ipKey, attemptId, windowMs, accountLimit, ipLimit);
    if (result === 0) return null;
    if (result !== 1) throw new Error('Unexpected sign-in limiter result');

    return {
      releaseAccount: async () => {
        await this.redis.zrem(accountKey, attemptId);
      },
    };
  }
}

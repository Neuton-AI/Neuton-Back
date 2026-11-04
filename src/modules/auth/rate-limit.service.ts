import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError } from '../../lib/errors.js';
import { authUnavailable } from './auth-errors.js';
import { rateLimitDigest } from './crypto.js';

export interface AuthLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; retryMs: number; windowId: string }>;
  release(key: string, windowId: string): Promise<void>;
}
const INCREMENT = `local n=redis.call('HINCRBY',KEYS[1],'count',1)
if n==1 then redis.call('HSET',KEYS[1],'window',ARGV[2]);redis.call('PEXPIRE',KEYS[1],ARGV[1]) end
local ttl=redis.call('PTTL',KEYS[1]);if ttl<0 then redis.call('PEXPIRE',KEYS[1],ARGV[1]);ttl=tonumber(ARGV[1]) end
return {n,ttl,redis.call('HGET',KEYS[1],'window')}`;
const RELEASE = `if redis.call('HGET',KEYS[1],'window')==ARGV[1] then
local n=tonumber(redis.call('HGET',KEYS[1],'count') or '0');if n>0 then redis.call('HINCRBY',KEYS[1],'count',-1) end end
return 1`;

export class RedisAuthLimitStore implements AuthLimitStore {
  private readonly redis: Redis;
  constructor(url: string) {
    const parsed = new URL(url);
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw authUnavailable();
    this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      commandTimeout: 3000, connectTimeout: 3000, retryStrategy: times => Math.min(times * 250, 3000),
      tls: parsed.protocol === 'rediss:' ? { rejectUnauthorized: true } : undefined });
    // Connection errors are surfaced through commands, without logging provider addresses.
    this.redis.on('error', () => {});
  }

  async increment(key: string, windowMs: number) {
    if (this.redis.status === 'wait') await this.redis.connect();
    const result = await this.redis.eval(INCREMENT, 1, key, windowMs, randomUUID());
    if (!Array.isArray(result) || result.length !== 3 || !Number.isSafeInteger(result[0]) || result[0] < 1 ||
      !Number.isFinite(result[1]) || result[1] < 0 || result[1] > windowMs || typeof result[2] !== 'string') throw authUnavailable();
    return { count: result[0] as number, retryMs: Math.max(1, result[1] as number), windowId: result[2] };
  }
  async release(key: string, windowId: string): Promise<void> { await this.redis.eval(RELEASE, 1, key, windowId); }
  close(): void { this.redis.disconnect(); }
}

interface LoginReservation { key: string; windowId: string }
export class AuthRateLimits {
  constructor(private readonly store: AuthLimitStore, private readonly key: Buffer,
    private readonly environment: string, private readonly namespace: string) {}

  async global(): Promise<void> { await this.consume('global', 'all', AUTH_POLICY.limits.globalPerMinute, 60_000); }

  async beginLogin(ip: string, normalizedEmail: string): Promise<LoginReservation> {
    await this.global();
    await this.consume('login-ip', ip, AUTH_POLICY.limits.loginIp, AUTH_POLICY.limits.loginWindowMs);
    const key = this.counterKey('login-account', normalizedEmail);
    const result = await this.increment(key, AUTH_POLICY.limits.loginWindowMs);
    if (result.count > AUTH_POLICY.limits.loginAccount) this.limited(result.retryMs);
    return { key, windowId: result.windowId };
  }

  async loginSucceeded(reservation: LoginReservation): Promise<void> {
    try { await this.store.release(reservation.key, reservation.windowId); }
    catch { throw authUnavailable(); }
  }

  async email(ip: string, normalizedEmail: string): Promise<boolean> {
    await this.global();
    await this.consume('mail-ip', ip, AUTH_POLICY.limits.mailIp, AUTH_POLICY.limits.mailWindowMs);
    const result = await this.increment(this.counterKey('mail-destination', normalizedEmail), AUTH_POLICY.limits.mailWindowMs);
    return result.count <= AUTH_POLICY.limits.mailDestination;
  }

  async oauthStart(ip: string): Promise<void> {
    await this.global();
    await this.consume('oauth-ip', ip, AUTH_POLICY.limits.startIp, AUTH_POLICY.limits.startWindowMs);
  }

  private async consume(dimension: string, value: string, limit: number, windowMs: number): Promise<void> {
    const result = await this.increment(this.counterKey(dimension, value), windowMs);
    if (result.count > limit) this.limited(result.retryMs);
  }
  private counterKey(dimension: string, value: string): string {
    return `${this.namespace}:${dimension}:${rateLimitDigest(this.key, this.environment, dimension, value)}`;
  }
  private async increment(key: string, windowMs: number) {
    try { return await this.store.increment(key, windowMs); }
    catch { throw authUnavailable(); }
  }
  private limited(retryMs: number): never {
    throw new AppError(429, 'AUTH_RATE_LIMITED', 'Too many attempts; try again later', { retryAfterSeconds: Math.ceil(retryMs / 1000) });
  }
}

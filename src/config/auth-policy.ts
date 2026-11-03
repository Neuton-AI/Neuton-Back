const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const AUTH_POLICY = Object.freeze({
  password: Object.freeze({ minCodePoints: 15, maxCodePoints: 128,
    memoryCostKiB: 65_536, timeCost: 3, parallelism: 1, maxConcurrentHashes: 4 }),
  session: Object.freeze({ idleMs: 7 * DAY, absoluteMs: 30 * DAY,
    activityWriteIntervalMs: 5 * MINUTE, recentAuthenticationMs: 10 * MINUTE }),
  tokens: Object.freeze({ bytes: 32, recoveryMs: 30 * MINUTE, confirmationMs: DAY,
    oauthMs: 10 * MINUTE, completionMs: MINUTE, browserContextMs: 30 * MINUTE,
    maxOutstandingOAuth: 5 }),
  limits: Object.freeze({ loginAccount: 10, loginIp: 60, loginWindowMs: 15 * MINUTE,
    mailDestination: 3, mailIp: 20, mailWindowMs: HOUR,
    startIp: 20, startWindowMs: HOUR, globalPerMinute: 300 }),
  mail: Object.freeze({ batchSize: 25, concurrency: 2, leaseMs: MINUTE,
    initialRetryMs: 30_000, maxRetryMs: HOUR, transportTimeoutMs: 30_000 }),
  cleanup: Object.freeze({ batchSize: 100, securityEventRetentionMs: 90 * DAY,
    sessionMetadataRetentionMs: 30 * DAY, intervalMs: MINUTE }),
  streamAuthorizationIntervalMs: 15_000,
  maxAuthBodyBytes: 16 * 1024,
  returnPaths: Object.freeze(['/', '/dashboard', '/profile']),
});

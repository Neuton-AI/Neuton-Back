import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { preAuthContexts, userSessions, users } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

const DAY_MS = 86_400_000;
const IDLE_MS = 7 * DAY_MS;
const ABSOLUTE_MS = 30 * DAY_MS;
const RETENTION_MS = 30 * DAY_MS;
const CLEANUP_BATCH_SIZE = 100;

type VerifiedAccount = Pick<typeof users.$inferSelect, 'id' | 'passwordHash' | 'securityVersion'>;

const sessionFields = {
  id: userSessions.id,
  userId: userSessions.userId,
  securityVersion: userSessions.securityVersion,
  createdAt: userSessions.createdAt,
  lastActivityAt: userSessions.lastActivityAt,
  idleExpiresAt: userSessions.idleExpiresAt,
  absoluteExpiresAt: userSessions.absoluteExpiresAt,
};

function digest(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export class SessionService {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async issue(account: VerifiedAccount, proofAt: Date) {
    const secret = randomBytes(32).toString('base64url');
    const idleExpiresAt = new Date(proofAt.getTime() + IDLE_MS);
    const absoluteExpiresAt = new Date(proofAt.getTime() + ABSOLUTE_MS);
    return this.withStore(() => this.db.transaction(async (tx) => {
      // Password proof happens outside the transaction. Recheck it under the same user lock as revocation.
      const [verified] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.id, account.id),
        eq(users.passwordHash, account.passwordHash),
        eq(users.securityVersion, account.securityVersion),
      )).for('update');
      if (!verified || idleExpiresAt <= this.now()) return null;

      const [session] = await tx.insert(userSessions).values({
        userId: account.id,
        securityVersion: account.securityVersion,
        secretDigest: digest(secret),
        createdAt: proofAt,
        lastActivityAt: proofAt,
        idleExpiresAt,
        absoluteExpiresAt,
      }).returning(sessionFields);
      if (!session) throw new Error('Session insert returned no row');
      return { secret, session };
    }));
  }

  async resolve(secret: string | undefined) {
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const now = this.now();
    return this.withStore(async () => {
      const [session] = await this.db.select({ ...sessionFields, email: users.email })
        .from(userSessions).innerJoin(users, eq(users.id, userSessions.userId))
        .where(and(
          eq(userSessions.secretDigest, digest(secret)),
          eq(userSessions.securityVersion, users.securityVersion),
          isNull(userSessions.revokedAt),
          gt(userSessions.idleExpiresAt, now),
          gt(userSessions.absoluteExpiresAt, now),
        ));
      return session ?? null;
    });
  }

  async cleanup() {
    const now = this.now();
    const retentionCutoff = new Date(now.getTime() - RETENTION_MS);
    const effectiveExpiry = sql`least(${userSessions.idleExpiresAt}, ${userSessions.absoluteExpiresAt}, ${userSessions.revokedAt})`;
    return this.withStore(() => this.db.transaction(async (tx) => {
      const staleSessions = tx.select({ id: userSessions.id }).from(userSessions)
        .where(lte(effectiveExpiry, retentionCutoff.toISOString())).orderBy(effectiveExpiry, userSessions.id)
        .limit(CLEANUP_BATCH_SIZE).for('update', { skipLocked: true });
      const staleContexts = tx.select({ digest: preAuthContexts.secretDigest }).from(preAuthContexts)
        .where(lte(preAuthContexts.expiresAt, now)).orderBy(preAuthContexts.expiresAt, preAuthContexts.secretDigest)
        .limit(CLEANUP_BATCH_SIZE).for('update', { skipLocked: true });
      const removedSessions = await tx.delete(userSessions).where(inArray(userSessions.id, staleSessions))
        .returning({ id: userSessions.id });
      const removedContexts = await tx.delete(preAuthContexts).where(inArray(preAuthContexts.secretDigest, staleContexts))
        .returning({ digest: preAuthContexts.secretDigest });
      return { sessions: removedSessions.length, preAuthContexts: removedContexts.length };
    }));
  }

  private async withStore<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      // Driver errors can include query parameters. Keep them out of the public error and request logs.
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Session store unavailable');
    }
  }
}

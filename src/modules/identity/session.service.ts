import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { preAuthContexts, userSessions, users } from '../../db/schema/index.js';
import { AppError, notFound, unauthorized } from '../../lib/errors.js';
import { apiLogger } from '../../lib/logger/index.js';

const DAY_MS = 86_400_000;
const IDLE_MS = 7 * DAY_MS;
const ABSOLUTE_MS = 30 * DAY_MS;
const RETENTION_MS = 30 * DAY_MS;
const CLEANUP_BATCH_SIZE = 100;
const RENEWAL_MS = 300_000;
const CONTEXT_MS = 30 * 60_000;

type VerifiedAccount = Pick<typeof users.$inferSelect, 'id' | 'passwordHash' | 'securityVersion'>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type SessionRecord = Pick<typeof userSessions.$inferSelect,
  'id' | 'userId' | 'securityVersion' | 'createdAt' | 'lastActivityAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>;

export function sessionMetadata(session: SessionRecord) {
  return {
    id: session.id,
    lastActivityAt: session.lastActivityAt.toISOString(),
    idleExpiresAt: session.idleExpiresAt.toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    nextRenewalAt: new Date(session.lastActivityAt.getTime() + RENEWAL_MS).toISOString(),
  };
}

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

const validSecret = (secret: string | undefined): secret is string => Boolean(secret && /^[A-Za-z0-9_-]{43}$/.test(secret));

function liveAt(now: Date) {
  return and(isNull(userSessions.revokedAt), gt(userSessions.idleExpiresAt, now), gt(userSessions.absoluteExpiresAt, now));
}

export class SessionService {
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch(() => apiLogger.warn({ event: 'session_cleanup_failed' }, 'Session cleanup failed'));
    }, 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy() { clearInterval(this.cleanupTimer); }

  async issue(account: VerifiedAccount, proofAt: Date) {
    return this.transaction(async (tx) => {
      // Password proof happens outside the transaction. Recheck it under the same user lock as revocation.
      const [verified] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.id, account.id),
        eq(users.passwordHash, account.passwordHash),
        eq(users.securityVersion, account.securityVersion),
      )).for('update');
      if (!verified || proofAt.getTime() + IDLE_MS <= this.now().getTime()) return null;
      return this.insert(tx, account, proofAt);
    });
  }

  async insert(tx: Transaction, account: Pick<VerifiedAccount, 'id' | 'securityVersion'>, proofAt: Date) {
    const secret = randomBytes(32).toString('base64url');
    const [session] = await tx.insert(userSessions).values({
      userId: account.id,
      securityVersion: account.securityVersion,
      secretDigest: digest(secret),
      createdAt: proofAt,
      lastActivityAt: proofAt,
      idleExpiresAt: new Date(proofAt.getTime() + IDLE_MS),
      absoluteExpiresAt: new Date(proofAt.getTime() + ABSOLUTE_MS),
    }).returning(sessionFields);
    if (!session) throw new Error('Session insert returned no row');
    return { secret, session };
  }

  async resolve(secret: string | undefined) {
    if (!validSecret(secret)) return null;
    const now = this.now();
    return this.withStore(async () => {
      const [session] = await this.db.select({ ...sessionFields, email: users.email })
        .from(userSessions).innerJoin(users, eq(users.id, userSessions.userId))
        .where(and(
          eq(userSessions.secretDigest, digest(secret)),
          eq(userSessions.securityVersion, users.securityVersion),
          liveAt(now),
        ));
      return session ?? null;
    });
  }

  async contextExists(secret: string | undefined): Promise<boolean> {
    if (!validSecret(secret)) return false;
    return this.withStore(async () => {
      const [context] = await this.db.select({ expiresAt: preAuthContexts.expiresAt }).from(preAuthContexts)
        .where(and(eq(preAuthContexts.secretDigest, digest(secret)), gt(preAuthContexts.expiresAt, this.now())));
      return Boolean(context);
    });
  }

  async createContext() {
    const secret = randomBytes(32).toString('base64url');
    const expires = new Date(this.now().getTime() + CONTEXT_MS);
    await this.withStore(() => this.db.insert(preAuthContexts).values({ secretDigest: digest(secret), expiresAt: expires }));
    return { secret, expires };
  }

  async lockCurrent(tx: Transaction, session: SessionRecord) {
    const [account] = await tx.select({ id: users.id, securityVersion: users.securityVersion, passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, session.userId)).for('update');
    if (account?.securityVersion !== session.securityVersion) throw unauthorized();
    const now = this.now();
    const [current] = await tx.select(sessionFields).from(userSessions)
      .where(and(eq(userSessions.id, session.id), eq(userSessions.userId, session.userId), liveAt(now))).for('update');
    if (!current) throw unauthorized();
    return { account, current, now };
  }

  async renew(session: SessionRecord) {
    return this.transaction(async (tx) => {
      const { current, now } = await this.lockCurrent(tx, session);
      if (now.getTime() - current.lastActivityAt.getTime() < RENEWAL_MS) return { session: current, extended: false };
      const idleExpiresAt = new Date(Math.min(now.getTime() + IDLE_MS, current.absoluteExpiresAt.getTime()));
      const [renewed] = await tx.update(userSessions).set({ lastActivityAt: now, idleExpiresAt })
        .where(eq(userSessions.id, current.id)).returning(sessionFields);
      return { session: renewed!, extended: true };
    });
  }

  async list(session: SessionRecord) {
    const rows = await this.withStore(() => this.db.select({ ...sessionFields, deviceLabel: userSessions.deviceLabel })
      .from(userSessions).innerJoin(users, eq(users.id, userSessions.userId))
      .where(and(eq(userSessions.userId, session.userId), eq(userSessions.securityVersion, users.securityVersion), liveAt(this.now())))
      .orderBy(desc(userSessions.lastActivityAt)));
    return rows.map((row) => ({ ...sessionMetadata(row), deviceLabel: row.deviceLabel,
      createdAt: row.createdAt.toISOString(), current: row.id === session.id }));
  }

  async revoke(session: SessionRecord, targetId: string) {
    return this.transaction(async (tx) => {
      const { now } = await this.lockCurrent(tx, session);
      const owned = and(eq(userSessions.id, targetId), eq(userSessions.userId, session.userId));
      const [target] = await tx.select({ revokedAt: userSessions.revokedAt }).from(userSessions).where(owned).for('update');
      if (!target) throw notFound('Session not found');
      if (target.revokedAt) return false;
      await tx.update(userSessions).set({ revokedAt: now, revocationReason: 'sign_out' }).where(owned);
      return true;
    });
  }

  async revokeAll(session: SessionRecord) {
    await this.transaction(async (tx) => {
      const { now } = await this.lockCurrent(tx, session);
      await this.advanceVersion(tx, session, now, 'sign_out_all');
    });
  }

  async advanceVersion(tx: Transaction, session: SessionRecord, now: Date, reason: 'sign_out_all' | 'password_change', passwordHash?: string) {
    const securityVersion = session.securityVersion + 1;
    await tx.update(users).set({ securityVersion, passwordHash }).where(eq(users.id, session.userId));
    await tx.update(userSessions).set({ revokedAt: now, revocationReason: reason })
      .where(and(eq(userSessions.userId, session.userId), isNull(userSessions.revokedAt)));
    return securityVersion;
  }

  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.withStore(() => this.db.transaction(operation));
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

  async withStore<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Driver errors can include query parameters. Keep them out of the public error and request logs.
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Session store unavailable');
    }
  }
}

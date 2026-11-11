import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { googleIdentities, users } from '../../db/schema/index.js';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { SessionService, type SessionRecord } from './session.service.js';
import { hashPassword, isLegacyPasswordHash, verifyPassword } from './password-hash.js';
import type { SignInLimiter, SignInReservation } from './signin-limiter.js';

type Credentials = { email: string; password: string };
const passwordAlreadySet = () => new AppError(409, 'PASSWORD_ALREADY_SET', 'Use Change password to update your existing password.');

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly signInLimiter: SignInLimiter,
  ) {}

  async signup({ email, password, fullName }: Credentials & { fullName?: string }, contextSecret: string | undefined, platform: string) {
    const passwordHash = await hashPassword(password);
    const proofAt = new Date();
    return this.sessions.transaction(async (tx) => {
      const context = await this.sessions.lockPasswordContext(tx, contextSecret);
      const [account] = await tx.insert(users).values({ email, passwordHash, fullName })
        .onConflictDoNothing({ target: users.email })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          avatarUrl: users.avatarUrl,
          securityVersion: users.securityVersion,
        });
      if (!account) throw conflict('Email is already registered');
      await this.sessions.consumeContext(tx, context?.secretDigest);
      const { securityVersion, ...user } = account;
      return { user, ...await this.sessions.insert(tx, { id: user.id, securityVersion }, proofAt, 'password', platform) };
    });
  }

  async signin({ email, password }: Credentials, sourceIp: string | undefined, contextSecret: string | undefined, platform: string) {
    let reservation: SignInReservation | null;
    try {
      if (!sourceIp) throw new Error('Missing source IP');
      reservation = await this.signInLimiter.reserve(email, sourceIp);
    } catch {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign-in is temporarily unavailable');
    }
    if (!reservation) throw new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many sign-in attempts');

    const [account] = await this.sessions.withStore(() => this.db.select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      fullName: users.fullName,
      avatarUrl: users.avatarUrl,
      securityVersion: users.securityVersion,
    }).from(users).where(eq(users.email, email)));

    const valid = await verifyPassword(password, account?.passwordHash);
    if (!account || account.passwordHash === null || !valid) {
      throw unauthorized('Invalid email or password');
    }
    // On a Redis failure, the reservation expires on its original deadline.
    await reservation.releaseAccount().catch(() => {});

    const { id, email: accountEmail, fullName, avatarUrl, passwordHash, securityVersion } = account;
    const user = { id, email: accountEmail, fullName, avatarUrl };
    const proofAt = new Date();
    const upgradedHash = isLegacyPasswordHash(passwordHash) ? await hashPassword(password) : undefined;
    const issued = await this.sessions.issue({ id, securityVersion, passwordHash }, proofAt, upgradedHash, contextSecret, platform);
    if (!issued) throw unauthorized('Credentials changed. Sign in again.');
    return { user, ...issued };
  }

  async signInMethods(userId: string) {
    const [methods] = await this.sessions.withStore(() => this.db.select({
      hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
      googleLinked: sql<boolean>`${googleIdentities.userId} IS NOT NULL`,
    }).from(users).leftJoin(googleIdentities, eq(googleIdentities.userId, users.id))
      .where(eq(users.id, userId)));
    if (!methods) throw unauthorized();
    return methods;
  }

  async addPassword(session: SessionRecord, password: string) {
    const [existing] = await this.sessions.withStore(() => this.db.select({ id: users.id }).from(users)
      .where(and(eq(users.id, session.userId), isNotNull(users.passwordHash))));
    if (existing) throw passwordAlreadySet();

    const passwordHash = await hashPassword(password);
    await this.sessions.transaction(async (tx) => {
      const { account } = await this.sessions.lockCurrent(tx, session);
      if (account.passwordHash !== null) throw passwordAlreadySet();
      await tx.update(users).set({ passwordHash }).where(eq(users.id, account.id));
    });
  }

  async unlinkGoogle(session: SessionRecord) {
    return this.sessions.transaction(async (tx) => {
      const { account, current, now } = await this.sessions.lockCurrent(tx, session);
      if (account.passwordHash === null) {
        throw new AppError(409, 'PASSWORD_REQUIRED', 'Add a password before unlinking Google.');
      }
      const [removed] = await tx.delete(googleIdentities).where(eq(googleIdentities.userId, account.id))
        .returning({ userId: googleIdentities.userId });
      if (removed) {
        await tx.update(users).set({ googleLinkRevision: sql`${users.googleLinkRevision} + 1` }).where(eq(users.id, account.id));
      }
      const revokedSessions = await this.sessions.revokeOtherGoogleSessions(tx, current, now);
      return { linkRemoved: Boolean(removed), revokedSessions };
    });
  }

  async changePassword(session: SessionRecord, input: { currentPassword: string; newPassword: string }, platform: string) {
    const [account] = await this.sessions.withStore(() => this.db.select({ passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, session.userId)));
    const valid = await verifyPassword(input.currentPassword, account?.passwordHash);
    if (!account || !valid) throw badRequest('Current password is incorrect');

    const proofAt = new Date();
    const passwordHash = await hashPassword(input.newPassword);
    return this.sessions.transaction(async (tx) => {
      const { account: locked, now } = await this.sessions.lockCurrent(tx, session);
      if (locked.passwordHash !== account.passwordHash) throw conflict('Password changed. Try again.');
      const securityVersion = await this.sessions.advanceVersion(tx, session, now, 'password_change', passwordHash);
      return this.sessions.insert(tx, { id: session.userId, securityVersion }, proofAt, 'password', platform);
    });
  }
}

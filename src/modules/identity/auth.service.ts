import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { SessionService, type SessionRecord } from './session.service.js';
import { hashPassword, verifyPassword } from './password-hash.js';

type Credentials = { email: string; password: string };

export class AuthService {
  constructor(private readonly db: Database, private readonly sessions: SessionService) {}

  async signup({ email, password, fullName }: Credentials & { fullName?: string }) {
    const passwordHash = await hashPassword(password);
    const proofAt = new Date();
    return this.sessions.transaction(async (tx) => {
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
      const { securityVersion, ...user } = account;
      return { user, ...await this.sessions.insert(tx, { id: user.id, securityVersion }, proofAt) };
    });
  }

  async signin({ email, password }: Credentials) {
    const [account] = await this.sessions.withStore(() => this.db.select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      fullName: users.fullName,
      avatarUrl: users.avatarUrl,
      securityVersion: users.securityVersion,
    }).from(users).where(eq(users.email, email)));

    const valid = await verifyPassword(password, account?.passwordHash);
    if (!account || !valid) throw unauthorized('Invalid email or password');

    const { id, fullName, avatarUrl } = account;
    const user = { id, email: account.email, fullName, avatarUrl };
    const issued = await this.sessions.issue(account, new Date());
    if (!issued) throw unauthorized('Credentials changed. Sign in again.');
    return { user, ...issued };
  }

  async changePassword(session: SessionRecord, input: { currentPassword: string; newPassword: string }) {
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
      return this.sessions.insert(tx, { id: session.userId, securityVersion }, proofAt);
    });
  }
}

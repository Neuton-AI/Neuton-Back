import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { profiles, users } from '../../db/schema/index.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import type { NeutonJwt } from './neuton-jwt.js';
import { hashPassword, verifyPassword } from './password-hash.js';

type Credentials = { email: string; password: string };

export class AuthService {
  constructor(private readonly db: Database, private readonly jwt: NeutonJwt) {}

  async signup({ email, password, fullName }: Credentials & { fullName?: string }) {
    const passwordHash = await hashPassword(password);
    const user = await this.db.transaction(async (tx) => {
      const [account] = await tx.insert(users).values({ email, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email });
      if (!account) throw conflict('Email is already registered');

      const name = fullName ?? null;
      await tx.insert(profiles).values({ id: account.id, fullName: name });
      return { ...account, fullName: name, avatarUrl: null };
    });
    return { token: await this.jwt.issue(user), user };
  }

  async signin({ email, password }: Credentials) {
    const [account] = await this.db.select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    }).from(users).leftJoin(profiles, eq(profiles.id, users.id)).where(eq(users.email, email));

    const valid = await verifyPassword(password, account?.passwordHash);
    if (!account || !valid) throw unauthorized('Invalid email or password');

    const { id, fullName, avatarUrl } = account;
    const user = { id, email: account.email, fullName, avatarUrl };
    return { token: await this.jwt.issue(user), user };
  }

  async changePassword(userId: string, input: { currentPassword: string; newPassword: string }) {
    const [account] = await this.db.select({ passwordHash: users.passwordHash })
      .from(users).where(eq(users.id, userId));
    const valid = await verifyPassword(input.currentPassword, account?.passwordHash);
    if (!account || !valid) throw badRequest('Current password is incorrect');

    const passwordHash = await hashPassword(input.newPassword);
    const [updated] = await this.db.update(users).set({ passwordHash })
      .where(and(eq(users.id, userId), eq(users.passwordHash, account.passwordHash)))
      .returning({ id: users.id });
    if (!updated) throw conflict('Password changed. Try again.');
    return { ok: true as const };
  }
}

import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { SessionRepository } from './session.repository.js';
import { SecurityEvents } from './security-events.js';
import { sql } from 'drizzle-orm';
import { digestSecret } from './crypto.js';
import { assertExpectedUser } from '../identity/expected-user.js';

export class SessionService {
  constructor(private readonly sessions: SessionRepository, private readonly events: SecurityEvents) {}
  async require(secret: string | undefined) {
    if (!secret) throw unauthorized();
    const session = await this.sessions.resolve(secret);
    if (!session) throw unauthorized();
    return session;
  }
  async active(secret: string | undefined) {
    const session = await this.require(secret);
    if (session.status !== 'active') throw forbidden('Confirm your email before accessing shop data');
    return session;
  }
  async renew(secret: string, correlationId: string, expectedUserId?: string | string[]) {
    const renewed = await this.sessions.withSession(secret, async (account, session) => {
      if (session.status !== 'active') throw forbidden('Confirm your email before renewing a business session');
      assertExpectedUser(expectedUserId, account.user.id);
      const result = await this.sessions.renew(account, session);
      await this.events.append(account.transaction, { event: 'session_renewed', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId: session.id });
      return result;
    });
    if (!renewed) throw unauthorized();
    return renewed;
  }
  async logout(secret: string, correlationId: string, browserSecret?: string, expectedUserId?: string | string[]): Promise<void> {
    const revoked = await this.sessions.withSession(secret, async (account, session) => {
      assertExpectedUser(expectedUserId, account.user.id);
      const result = await this.sessions.revoke(account, session.id);
      if (browserSecret) await account.transaction.execute(sql`delete from auth_private.browser_contexts
        where token_digest=${digestSecret('browser_context', browserSecret)}`);
      await this.events.append(account.transaction, { event: 'logout', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId: session.id });
      return result;
    });
    if (!revoked) throw unauthorized();
  }

  async list(secret: string, expectedUserId?: string | string[]) {
    const devices = await this.sessions.withSession(secret, async (account, session) => {
      if (session.status !== 'active') throw forbidden('Confirm your email before managing devices');
      assertExpectedUser(expectedUserId, account.user.id);
      return this.sessions.list(account, session.id);
    });
    if (!devices) throw unauthorized();
    return { sessions: devices };
  }

  async revokeDevice(secret: string, sessionId: string, correlationId: string, expectedUserId?: string | string[]) {
    const result = await this.sessions.withSession(secret, async (account, session) => {
      if (session.status !== 'active') throw forbidden('Confirm your email before managing devices');
      assertExpectedUser(expectedUserId, account.user.id);
      if (!(await this.sessions.revoke(account, sessionId, 'device_revoked'))) throw notFound('Session not found');
      await this.events.append(account.transaction, { event: 'session_revoked', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId });
      return { current: session.id === sessionId };
    });
    if (!result) throw unauthorized();
    return result;
  }

  async logoutAll(secret: string, correlationId: string, browserSecret?: string, expectedUserId?: string | string[]): Promise<void> {
    const revoked = await this.sessions.withSession(secret, async (account, session) => {
      assertExpectedUser(expectedUserId, account.user.id);
      await this.sessions.invalidateSecurityState(account);
      if (browserSecret) {
        await account.transaction.execute(sql`delete from auth_private.browser_contexts
          where token_digest=${digestSecret('browser_context', browserSecret)}`);
      }
      await this.events.append(account.transaction, { event: 'logout_all', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId: session.id });
      return true;
    });
    if (!revoked) throw unauthorized();
  }
}

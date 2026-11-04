import { forbidden, unauthorized } from '../../lib/errors.js';
import { SessionRepository } from './session.repository.js';
import { SecurityEvents } from './security-events.js';
import { sql } from 'drizzle-orm';
import { digestSecret } from './crypto.js';

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
  async renew(secret: string, correlationId: string) {
    const renewed = await this.sessions.withSession(secret, async (account, session) => {
      if (session.status !== 'active') throw forbidden('Confirm your email before renewing a business session');
      const result = await this.sessions.renew(account, session);
      await this.events.append(account.transaction, { event: 'session_renewed', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId: session.id });
      return result;
    });
    if (!renewed) throw unauthorized();
    return renewed;
  }
  async logout(secret: string, correlationId: string, browserSecret?: string): Promise<void> {
    const revoked = await this.sessions.withSession(secret, async (account, session) => {
      const result = await this.sessions.revoke(account, session.id);
      if (browserSecret) await account.transaction.execute(sql`delete from auth_private.browser_contexts
        where token_digest=${digestSecret('browser_context', browserSecret)}`);
      await this.events.append(account.transaction, { event: 'logout', result: 'success', correlationId,
        actorUserId: account.user.id, sessionId: session.id });
      return result;
    });
    if (!revoked) throw unauthorized();
  }
}

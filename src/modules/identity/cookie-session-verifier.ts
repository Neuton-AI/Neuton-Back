import { SessionVerifier } from './identity.ports.js';
import { SessionRepository } from '../auth/session.repository.js';

export class CookieSessionVerifier extends SessionVerifier {
  constructor(private readonly sessions: Pick<SessionRepository, 'resolve'>) { super(); }
  override async verify(secret: string) {
    const session = await this.sessions.resolve(secret);
    if (!session) return null;
    return { id: session.userId, email: session.email, sessionId: session.id, status: session.status };
  }
}

import type { z } from 'zod';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { SessionRepository } from './session.repository.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { SecurityEvents } from './security-events.js';
import { invalidCredentials } from './auth-errors.js';
import type { PasswordHasher } from './auth.ports.js';
import type { AuthRequestContext } from './account.service.js';
import type { loginInput } from './contracts.js';

export class PasswordService {
  constructor(private readonly auth: AuthRepository, private readonly accounts: AccountRepository,
    private readonly sessions: SessionRepository, private readonly hasher: PasswordHasher,
    private readonly limits: AuthRateLimits, private readonly events: SecurityEvents) {}

  async login(input: z.infer<typeof loginInput>, context: AuthRequestContext) {
    const reservation = await this.limits.beginLogin(context.ip, input.email.normalized);
    const proof = await this.accounts.findPassword(input.email.normalized);
    let matches = false;
    if (proof) matches = await this.hasher.verify(proof.encodedHash, input.password);
    else await this.hasher.verifyDummy(input.password);
    if (!proof || !matches || proof.status === 'disabled') {
      await this.auth.transaction(transaction => this.events.append(transaction, { event: 'login', result: 'denied',
        correlationId: context.traceId, subjectUserId: proof?.userId ?? null, metadata: { method: 'password', reason: 'invalid_credentials' } }));
      throw invalidCredentials();
    }
    let rehash: string | undefined;
    if (this.hasher.needsRehash(proof.encodedHash)) rehash = await this.hasher.hash(input.password);
    await this.limits.loginSucceeded(reservation);
    const issued = await this.auth.withUser(proof.userId, async account => {
      if (!(await this.accounts.credentialUnchanged(account, proof))) throw invalidCredentials();
      if (rehash && !(await this.accounts.replacePassword(account, proof.encodedHash, rehash, true))) throw invalidCredentials();
      const session = await this.sessions.issue(account, { method: 'password' }, { ip: context.ip, userAgent: context.userAgent });
      await this.events.append(account.transaction, { event: 'login', result: 'success', correlationId: context.traceId,
        actorUserId: account.user.id, sessionId: session.sessionId, metadata: { method: 'password' } });
      return session;
    });
    if (!issued) throw invalidCredentials();
    return issued;
  }
}

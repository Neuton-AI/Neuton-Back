import type { z } from 'zod';
import { AuthRepository } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { SessionRepository } from './session.repository.js';
import { AuthRateLimits } from './rate-limit.service.js';
import { SecurityEvents } from './security-events.js';
import { invalidAction, invalidCredentials } from './auth-errors.js';
import { ActionTokenRepository } from './action-token.repository.js';
import type { PasswordHasher } from './auth.ports.js';
import type { AuthRequestContext } from './account.service.js';
import type { loginInput } from './contracts.js';
import type { VerifiedSessionReference } from '../identity/verified-session.js';
import { assertVerifiedSession } from '../identity/verified-session.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';

export class PasswordService {
  constructor(private readonly auth: AuthRepository, private readonly accounts: AccountRepository,
    private readonly sessions: SessionRepository, private readonly hasher: PasswordHasher,
    private readonly limits: AuthRateLimits, private readonly events: SecurityEvents, private readonly outbox: MailOutboxRepository,
    private readonly actions: ActionTokenRepository) {}

  async recovery(normalizedEmail: string, context: AuthRequestContext): Promise<void> {
    if (!(await this.limits.email(context.ip, normalizedEmail))) return;
    const proof = await this.accounts.findPassword(normalizedEmail);
    if (!proof || proof.status !== 'active') return;
    await this.auth.withUser(proof.userId, async account => {
      if (account.user.status !== 'active' || !account.user.emailConfirmedAt ||
        account.user.normalizedEmail !== normalizedEmail || !(await this.accounts.credentialUnchanged(account, proof))) {
        return;
      }
      const action = await this.actions.issue(account, 'password_reset', null);
      await this.outbox.enqueueAction(account, action);
      await this.events.append(account.transaction, { event: 'password_recovery_requested', result: 'success', correlationId: context.traceId,
        subjectUserId: account.user.id });
    });
  }

  async reset(secret: string, newPassword: string, context: AuthRequestContext): Promise<void> {
    await this.limits.global();
    const target = await this.actions.find('password_reset', secret);
    if (!target) throw invalidAction();
    const proof = await this.accounts.findPasswordForUser(target.userId);
    if (!proof || proof.status !== 'active') throw invalidAction();
    const encodedHash = await this.hasher.hash(newPassword);
    const completed = await this.auth.withUser(target.userId, async account => {
      if (!account.user.emailConfirmedAt || !(await this.accounts.credentialUnchanged(account, proof)) ||
        !(await this.actions.consume(account, { purpose: 'password_reset', secret }))) {
        throw invalidAction();
      }
      if (!(await this.accounts.replacePassword(account, proof.encodedHash, encodedHash))) throw invalidAction();
      await this.auth.invalidateSecurityState(account, 'password_reset');
      await this.outbox.enqueueNotice(account, 'password_reset');
      await this.events.append(account.transaction, { event: 'password_reset', result: 'success', correlationId: context.traceId,
        subjectUserId: account.user.id });
      return true;
    });
    if (!completed) throw invalidAction();
  }

  async change(reference: VerifiedSessionReference, input: { currentPassword: string; newPassword: string }, context: AuthRequestContext) {
    assertVerifiedSession(reference);
    const proof = await this.accounts.findPasswordForUser(reference.userId);
    const reservation = await this.limits.beginLogin(context.ip, reference.userId);
    if (!proof) { await this.hasher.verifyDummy(input.currentPassword); throw invalidCredentials(); }
    if (!(await this.hasher.verify(proof.encodedHash, input.currentPassword))) throw invalidCredentials();
    const encodedHash = await this.hasher.hash(input.newPassword);
    await this.limits.loginSucceeded(reservation);
    const issued = await this.auth.withUser(reference.userId, async account => {
      const current = await this.sessions.current(account, reference.sessionId);
      if (!current || current.status !== 'active' || !(await this.accounts.credentialUnchanged(account, proof))) throw invalidCredentials();
      if (!(await this.accounts.replacePassword(account, proof.encodedHash, encodedHash))) throw invalidCredentials();
      await this.auth.invalidateSecurityState(account, 'password_changed');
      await this.outbox.enqueueNotice(account, 'password_changed');
      const fresh = await this.auth.lockUser(account.transaction, account.user.id);
      if (!fresh) throw invalidCredentials();
      const session = await this.sessions.issue(fresh, { method: 'password' }, { ip: context.ip, userAgent: context.userAgent });
      await this.events.append(account.transaction, { event: 'password_changed', result: 'success', correlationId: context.traceId,
        actorUserId: reference.userId, sessionId: session.sessionId, metadata: { method: 'password' } });
      return session;
    });
    if (!issued) throw invalidCredentials();
    return issued;
  }

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

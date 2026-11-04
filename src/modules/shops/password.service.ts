import { Inject, Injectable, Optional } from '@nestjs/common';
import { PasswordService as AccountPasswords } from '../auth/password.service.js';
import { authUnavailable } from '../auth/auth-errors.js';
import type { SessionActor } from '../identity/session.guard.js';
@Injectable()
export class PasswordService {
  constructor(
    @Optional() @Inject(AccountPasswords) private readonly passwords?: AccountPasswords,
  ) {}
  async change(
    actor: SessionActor,
    input: { currentPassword: string; newPassword: string },
  ) {
    if (!this.passwords) throw authUnavailable();
    return this.passwords.change(actor.session, input, { ip: actor.ipAddress ?? 'unknown', traceId: actor.traceId });
  }
}

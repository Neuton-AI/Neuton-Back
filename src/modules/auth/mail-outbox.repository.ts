import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { LockedAuthAccount } from './auth.repository.js';
import type { ActionPurpose } from './action-token.repository.js';
import { AuthEncryption, digestSecret } from './crypto.js';
import type { EncryptionPurpose } from './crypto.js';
import { MailTemplates } from './mail-templates.js';
import type { MailContent, SecurityNotice } from './mail-templates.js';

export class MailOutboxRepository {
  constructor(private readonly auth: AuthRepository, private readonly encryption: AuthEncryption,
    private readonly templates: MailTemplates) {}

  async enqueueAction(account: LockedAuthAccount, action: { id: string; purpose: ActionPurpose; secret: string }): Promise<string> {
    this.auth.assertLocked(account);
    const [token] = await authRows(account.transaction, sql`select t.expires_at as "expiresAt",
      case when t.purpose='password_reset' then u.normalized_email else t.intended_email end as destination
      from auth_private.action_tokens t join auth_private.users u on u.id=t.user_id
      where t.id=${action.id}::uuid and t.user_id=${account.user.id}::uuid and t.purpose=${action.purpose}
      and t.token_digest=${digestSecret(action.purpose, action.secret)} and t.security_version=u.security_version
      and t.security_version=${account.user.securityVersion} and t.consumed_at is null and t.invalidated_at is null
      and t.expires_at>clock_timestamp() and ((t.purpose='confirm_email' and u.status='pending_email'
        and t.intended_email=u.normalized_email) or (t.purpose='email_change' and u.status='active')
        or (t.purpose='password_reset' and u.status='active' and exists(select 1 from auth_private.password_credentials p where p.user_id=u.id)))`,
    z.object({ expiresAt: z.coerce.date(), destination: z.string() }));
    if (!token) throw new Error('Current account action required for mail');
    return this.insert(account, action.purpose, token.destination, this.templates.action(action.purpose, action.secret),
      token.expiresAt, action.id);
  }

  async enqueueNotice(account: LockedAuthAccount, notice: SecurityNotice): Promise<string> {
    this.auth.assertLocked(account);
    const [current] = await authRows(account.transaction, sql`select normalized_email as destination,
      clock_timestamp()+${AUTH_POLICY.tokens.confirmationMs}*interval '1 millisecond' as "expiresAt"
      from auth_private.users where id=${account.user.id}::uuid`,
    z.object({ destination: z.string(), expiresAt: z.coerce.date() }));
    if (!current) throw new Error('Current account required for mail');
    return this.insert(account, 'security_notice', current.destination, this.templates.notice(notice), current.expiresAt, null);
  }

  private async insert(account: LockedAuthAccount, purpose: ActionPurpose | 'security_notice', destination: string,
    content: MailContent, expiresAt: Date, actionTokenId: string | null): Promise<string> {
    const id = randomUUID();
    const encryptionPurpose: EncryptionPurpose = `mail:${purpose}`;
    const encrypted = this.encryption.encrypt(encryptionPurpose, id, JSON.stringify(content));
    await account.transaction.execute(sql`insert into auth_private.mail_outbox
      (id,purpose,destination,encrypted_payload,payload_key_id,action_token_id,expires_at)
      values(${id}::uuid,${purpose},${destination},${encrypted.ciphertext},${encrypted.keyId},${actionTokenId}::uuid,${expiresAt})`);
    return id;
  }
}

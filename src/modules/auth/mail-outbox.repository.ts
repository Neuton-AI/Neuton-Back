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
import type { AuthTransaction, AuthMailMessage } from './auth.ports.js';

export interface MailLease { id: string; leaseToken: string }
export type MailFailureCode = 'MAIL_DELIVERY_UNAVAILABLE' | 'AUTH_SECRET_UNAVAILABLE' | 'MAIL_PAYLOAD_INVALID';
const leaseSchema = z.object({ id: z.string().uuid(), leaseToken: z.string().uuid() });
const ownedLease = (lease: MailLease) => sql`m.id=${lease.id}::uuid and m.lease_token=${lease.leaseToken}::uuid
  and m.lease_until>clock_timestamp() and m.sent_at is null and m.discarded_at is null`;

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

  claim(limit: number): Promise<MailLease[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > AUTH_POLICY.mail.batchSize) throw new Error('Invalid mail batch size');
    return this.auth.transaction(transaction => authRows(transaction, sql`with due as (
      select id from auth_private.mail_outbox where sent_at is null and discarded_at is null
      and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp())
      order by next_attempt_at,created_at,id limit ${limit} for update skip locked)
      update auth_private.mail_outbox m set lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+${AUTH_POLICY.mail.leaseMs}*interval '1 millisecond',attempts=m.attempts+1
      from due where m.id=due.id returning m.id,m.lease_token as "leaseToken"`, leaseSchema));
  }

  async prepare(lease: MailLease): Promise<AuthMailMessage | null> {
    const [target] = await this.auth.transaction(transaction => authRows(transaction, sql`select t.user_id as "userId"
      from auth_private.mail_outbox m left join auth_private.action_tokens t on t.id=m.action_token_id
      where ${ownedLease(lease)}`, z.object({ userId: z.string().uuid().nullable() })));
    if (!target) return null;
    if (target.userId) {
      return this.auth.withUser(target.userId, account => this.prepareLocked(account.transaction, lease, account.user.id));
    }
    return this.auth.transaction(transaction => this.prepareLocked(transaction, lease, null));
  }

  private async prepareLocked(transaction: AuthTransaction, lease: MailLease, userId: string | null): Promise<AuthMailMessage | null> {
    const [row] = await authRows(transaction, sql`select m.id,m.purpose,m.destination,m.encrypted_payload as payload,
      m.payload_key_id as "keyId",(m.expires_at>clock_timestamp() and (m.purpose='security_notice' or (
        t.user_id=${userId}::uuid and t.purpose=m.purpose and t.security_version=u.security_version
        and t.consumed_at is null and t.invalidated_at is null and t.expires_at>clock_timestamp()
        and ((t.purpose='confirm_email' and u.status='pending_email' and t.intended_email=u.normalized_email
          and m.destination=t.intended_email) or (t.purpose='email_change' and u.status='active' and m.destination=t.intended_email)
          or (t.purpose='password_reset' and u.status='active' and m.destination=u.normalized_email
            and exists(select 1 from auth_private.password_credentials p where p.user_id=u.id)))))) as valid
      from auth_private.mail_outbox m left join auth_private.action_tokens t on t.id=m.action_token_id
      left join auth_private.users u on u.id=t.user_id where ${ownedLease(lease)}`,
    z.object({ id: z.string().uuid(), purpose: z.enum(['confirm_email', 'password_reset', 'email_change', 'security_notice']),
      destination: z.string(), payload: z.string(), keyId: z.string(), valid: z.boolean().nullable() }));
    if (!row) return null;
    if (row.valid !== true) {
      await transaction.execute(sql`update auth_private.mail_outbox m set discarded_at=clock_timestamp(),encrypted_payload=null,
        payload_key_id=null,lease_token=null,lease_until=null,last_error_code='MAIL_SUPERSEDED' where ${ownedLease(lease)}`);
      return null;
    }
    const purpose: EncryptionPurpose = `mail:${row.purpose}`;
    const plaintext = this.encryption.decrypt(purpose, row.id, { keyId: row.keyId, ciphertext: row.payload });
    const content = z.object({ subject: z.string().max(200), text: z.string().max(60_000) }).strict().parse(JSON.parse(plaintext));
    return { id: row.id, to: row.destination, ...content };
  }

  markSent(lease: MailLease): Promise<boolean> {
    return this.updateLease(lease, sql`sent_at=clock_timestamp(),encrypted_payload=null,payload_key_id=null,
      lease_token=null,lease_until=null,last_error_code=null`);
  }

  extend(lease: MailLease): Promise<boolean> {
    return this.updateLease(lease, sql`lease_until=clock_timestamp()+${AUTH_POLICY.mail.leaseMs}*interval '1 millisecond'`);
  }

  async retry(lease: MailLease, code: MailFailureCode): Promise<boolean> {
    const [updated] = await this.auth.transaction(transaction => authRows(transaction, sql`with clock as(select clock_timestamp() as now)
      update auth_private.mail_outbox m set lease_token=null,lease_until=null,last_error_code=${code},
      next_attempt_at=least(m.expires_at,clock.now+least(${AUTH_POLICY.mail.maxRetryMs},
        ${AUTH_POLICY.mail.initialRetryMs}*power(2,least(m.attempts-1,16)))*interval '1 millisecond'),
      discarded_at=case when m.expires_at<=clock.now then clock.now else null end,
      encrypted_payload=case when m.expires_at<=clock.now then null else m.encrypted_payload end,
      payload_key_id=case when m.expires_at<=clock.now then null else m.payload_key_id end
      from clock where ${ownedLease(lease)} returning m.id`, z.object({ id: z.string().uuid() })));
    return updated !== undefined;
  }

  private async updateLease(lease: MailLease, assignments: ReturnType<typeof sql>): Promise<boolean> {
    const [updated] = await this.auth.transaction(transaction => authRows(transaction,
      sql`update auth_private.mail_outbox m set ${assignments} where ${ownedLease(lease)} returning m.id`, z.object({ id: z.string().uuid() })));
    return updated !== undefined;
  }
}

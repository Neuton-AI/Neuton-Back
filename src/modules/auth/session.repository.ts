import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { unauthorized } from '../../lib/errors.js';
import { referenceVerifiedSession } from '../identity/verified-session.js';
import { AuthRepository, authRows } from './auth.repository.js';
import type { LockedAuthAccount } from './auth.repository.js';
import type { AuthTransaction } from './auth.ports.js';
import { digestSecret, newSecret } from './crypto.js';
import { isBearerSecret } from './normalization.js';
import { sessionRecordSchema } from './session.types.js';
import type { ResolvedSession, SessionRecord, SessionProof, SessionDevice } from './session.types.js';

const selectSession = sql`select s.id,s.user_id as "userId",u.email,u.status,u.email_confirmed_at as "emailConfirmedAt",
  u.security_version as "securityVersion",s.csrf_digest as "csrfDigest",s.authenticated_at as "authenticatedAt",
  s.authentication_method as "authenticationMethod",s.recent_authenticated_at as "recentAuthenticatedAt",
  s.last_activity_at as "lastActivityAt",s.idle_expires_at as "idleExpiresAt",s.absolute_expires_at as "absoluteExpiresAt"
  from auth_private.sessions s join auth_private.users u on u.id=s.user_id`;
const validSession = sql`s.revoked_at is null and s.security_version=u.security_version and u.status in ('pending_email','active')
  and s.idle_expires_at>clock_timestamp() and s.absolute_expires_at>clock_timestamp()`;

export class SessionRepository {
  constructor(private readonly auth: AuthRepository) {}

  async resolve(secret: string): Promise<ResolvedSession | null> {
    if (!isBearerSecret(secret)) return null;
    const record = await this.auth.transaction(transaction => this.find(transaction, secret));
    return record ? { ...record, reference: referenceVerifiedSession(record.userId, record.id) } : null;
  }

  async withSession<T>(secret: string, work: (account: LockedAuthAccount, session: SessionRecord) => Promise<T>): Promise<T | null> {
    const resolved = await this.resolve(secret);
    if (!resolved) return null;
    return this.auth.withUser(resolved.userId, async account => {
      const current = await this.find(account.transaction, secret, true);
      if (!current || current.userId !== account.user.id) return null;
      return work(account, current);
    });
  }

  private async find(transaction: AuthTransaction, secret: string, lock = false): Promise<SessionRecord | null> {
    const suffix = lock ? sql`for update of s` : sql``;
    const [record] = await authRows(transaction, sql`${selectSession} where s.token_digest=${digestSecret('session', secret)}
      and ${validSession} ${suffix}`, sessionRecordSchema);
    return record ?? null;
  }

  async issue(account: LockedAuthAccount, proof: SessionProof, device: SessionDevice, replaceSessionId?: string) {
    this.auth.assertLocked(account);
    if (account.user.status === 'disabled') throw unauthorized();
    if (replaceSessionId && !(await this.revoke(account, replaceSessionId, 'replaced'))) throw unauthorized();
    const secret = newSecret();
    const sessionId = randomUUID();
    const csrf = digestSecret('csrf', newSecret());
    const recent = proof.method === 'google' ? proof.recentAuthenticatedAt ?? null : null;
    if (recent && (!Number.isFinite(recent.getTime()) || recent.getTime() > Date.now() + 60_000)) throw unauthorized();
    const [created] = await authRows(account.transaction, sql`with clock as(select clock_timestamp() as now)
      insert into auth_private.sessions(id,user_id,token_digest,csrf_digest,security_version,authenticated_at,authentication_method,
        recent_authenticated_at,last_activity_at,idle_expires_at,absolute_expires_at,user_agent,ip_address)
      select ${sessionId}::uuid,u.id,${digestSecret('session', secret)},${csrf},u.security_version,clock.now,${proof.method},
        case when ${proof.method}='password' then clock.now else ${recent}::timestamptz end,clock.now,
        clock.now+${AUTH_POLICY.session.idleMs}*interval '1 millisecond',clock.now+${AUTH_POLICY.session.absoluteMs}*interval '1 millisecond',
        ${device.userAgent?.slice(0, 256) ?? null},${device.ip?.slice(0, 45) ?? null}
      from auth_private.users u,clock where u.id=${account.user.id}::uuid and u.security_version=${account.user.securityVersion}
      and u.status in ('pending_email','active') returning idle_expires_at as "expiresAt"`, z.object({ expiresAt: z.coerce.date() }));
    if (!created) throw unauthorized();
    return { secret, sessionId, expiresAt: created.expiresAt };
  }

  async csrfContext(secret: string) {
    const session = await this.resolve(secret);
    return session ? { id: session.id, csrfDigest: session.csrfDigest } : null;
  }
  async current(account: LockedAuthAccount, sessionId: string): Promise<SessionRecord | null> {
    this.auth.assertLocked(account);
    const [session] = await authRows(account.transaction, sql`${selectSession} where s.id=${sessionId}::uuid
      and s.user_id=${account.user.id}::uuid and ${validSession} for update of s`, sessionRecordSchema);
    return session ?? null;
  }
  rotateCsrf(secret: string, digest: string) {
    return this.withSession(secret, async (account, session) => {
      await account.transaction.execute(sql`update auth_private.sessions set csrf_digest=${digest} where id=${session.id}::uuid`);
      return { expiresAt: session.idleExpiresAt };
    });
  }

  async renew(account: LockedAuthAccount, session: SessionRecord) {
    this.auth.assertLocked(account);
    const [updated] = await authRows(account.transaction, sql`with clock as(select clock_timestamp() as now)
      update auth_private.sessions s set last_activity_at=clock.now,
      idle_expires_at=least(s.absolute_expires_at,clock.now+${AUTH_POLICY.session.idleMs}*interval '1 millisecond')
      from clock where s.id=${session.id}::uuid and s.user_id=${account.user.id}::uuid and s.revoked_at is null
      and s.security_version=${account.user.securityVersion} and s.idle_expires_at>clock.now and s.absolute_expires_at>clock.now
      and s.last_activity_at<=clock.now-${AUTH_POLICY.session.activityWriteIntervalMs}*interval '1 millisecond'
      returning s.idle_expires_at as "idleExpiresAt",s.absolute_expires_at as "absoluteExpiresAt"`,
    z.object({ idleExpiresAt: z.coerce.date(), absoluteExpiresAt: z.coerce.date() }));
    if (updated) return updated;
    const [current] = await authRows(account.transaction, sql`select s.idle_expires_at as "idleExpiresAt",s.absolute_expires_at as "absoluteExpiresAt"
      from auth_private.sessions s join auth_private.users u on u.id=s.user_id
      where s.id=${session.id}::uuid and s.user_id=${account.user.id}::uuid and ${validSession}`,
    z.object({ idleExpiresAt: z.coerce.date(), absoluteExpiresAt: z.coerce.date() }));
    if (!current) throw unauthorized();
    return current;
  }

  async revoke(account: LockedAuthAccount, sessionId: string, reason = 'logout'): Promise<boolean> {
    this.auth.assertLocked(account);
    const [revoked] = await authRows(account.transaction, sql`update auth_private.sessions set revoked_at=clock_timestamp(),revoked_reason=${reason}
      where id=${sessionId}::uuid and user_id=${account.user.id}::uuid and revoked_at is null returning id`, z.object({ id: z.string().uuid() }));
    return revoked !== undefined;
  }

  async list(account: LockedAuthAccount, currentSessionId: string) {
    this.auth.assertLocked(account);
    const records = await authRows(account.transaction, sql`select s.id,s.created_at as "createdAt",
      s.last_activity_at as "lastActivityAt",s.idle_expires_at as "idleExpiresAt",
      s.absolute_expires_at as "absoluteExpiresAt",s.user_agent as device
      from auth_private.sessions s join auth_private.users u on u.id=s.user_id
      where s.user_id=${account.user.id}::uuid and ${validSession}
      order by s.created_at desc,s.id`, z.object({ id: z.string().uuid(), createdAt: z.coerce.date(),
        lastActivityAt: z.coerce.date(), idleExpiresAt: z.coerce.date(), absoluteExpiresAt: z.coerce.date(),
        device: z.string().max(256).nullable() }));
    return records.map(record => ({ ...record, current: record.id === currentSessionId }));
  }

  invalidateSecurityState(account: LockedAuthAccount) {
    return this.auth.invalidateSecurityState(account, 'logout_all');
  }
}

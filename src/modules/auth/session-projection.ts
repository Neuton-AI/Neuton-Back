import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { withUserTransaction } from '../../db/tenant-context.js';
import { unauthorized } from '../../lib/errors.js';
import { authRows } from './auth.repository.js';
import { AccountRepository } from './account.repository.js';
import { SessionRepository } from './session.repository.js';
import type { AuthTransaction } from './auth.ports.js';
import type { SessionDto } from './contracts.js';

export interface SessionApplicationDatabase { transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T> }
const membershipSchema = z.object({ shopId: z.string().uuid(), role: z.enum(['owner', 'admin', 'member']), shop: z.object({
  id: z.string().uuid(), name: z.string(), slug: z.string(), currency: z.string(), timezone: z.string(), storeAddress: z.string().nullable(),
  targetProfitMargin: z.string(), hourlyLaborCost: z.string(), deliveryBaseFee: z.string(), deliveryRatePerKm: z.string(),
}) });

export class SessionProjection {
  constructor(private readonly accounts: AccountRepository,
    private readonly sessions: SessionRepository, private readonly application: SessionApplicationDatabase, private readonly environment: string) {}

  async inspect(secret: string): Promise<SessionDto> {
    const current = await this.sessions.withSession(secret, async (account, session) => ({
      session, profile: await this.accounts.publicProjection(account),
    }));
    if (!current) throw unauthorized();
    const { session, profile } = current;
    let memberships: SessionDto['memberships'] = [];
    if (session.status === 'active') {
      const resolved = await this.sessions.resolve(secret);
      if (!resolved) throw unauthorized();
      memberships = await withUserTransaction(this.application, resolved.reference, scope => authRows(scope.database, sql`
        select m.shop_id as "shopId",m.role,jsonb_build_object('id',s.id,'name',s.name,'slug',s.slug,'currency',s.currency,
          'timezone',s.timezone,'storeAddress',s.store_address,'targetProfitMargin',s.target_profit_margin::text,
          'hourlyLaborCost',s.hourly_labor_cost::text,'deliveryBaseFee',s.delivery_base_fee::text,
          'deliveryRatePerKm',s.delivery_rate_per_km::text) as shop
        from public.shop_members m join public.shops s on s.id=m.shop_id where m.user_id=${session.userId}::uuid order by s.name,s.id`, membershipSchema));
    }
    const recentExpiry = session.recentAuthenticatedAt
      ? new Date(session.recentAuthenticatedAt.getTime() + AUTH_POLICY.session.recentAuthenticationMs).toISOString() : null;
    return { environment: this.environment, user: { id: session.userId, email: profile.email, fullName: profile.fullName,
      avatarUrl: profile.avatarUrl, status: session.status, emailConfirmedAt: profile.emailConfirmedAt }, memberships,
      session: { id: session.id, idleExpiresAt: session.idleExpiresAt.toISOString(), absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        recentAuthenticationExpiresAt: recentExpiry, renewAfter: new Date(session.lastActivityAt.getTime() + AUTH_POLICY.session.activityWriteIntervalMs).toISOString() } };
  }
}

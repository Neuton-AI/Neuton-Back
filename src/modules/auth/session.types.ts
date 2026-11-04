import { z } from 'zod';
import type { VerifiedSessionReference } from '../identity/verified-session.js';

export const sessionRecordSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid(), email: z.string(),
  status: z.enum(['pending_email', 'active']), emailConfirmedAt: z.coerce.date().nullable(), securityVersion: z.number().int(),
  csrfDigest: z.string(), authenticatedAt: z.coerce.date(), authenticationMethod: z.enum(['password', 'google']),
  recentAuthenticatedAt: z.coerce.date().nullable(), lastActivityAt: z.coerce.date(), idleExpiresAt: z.coerce.date(), absoluteExpiresAt: z.coerce.date() });
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type ResolvedSession = SessionRecord & { reference: VerifiedSessionReference };
export interface SessionProof { method: 'password' | 'google'; recentAuthenticatedAt?: Date | null }
export interface SessionDevice { userAgent?: string; ip?: string }

import { and, eq, sql } from 'drizzle-orm';
import { googleIdentities, users, type GoogleCompletionProof } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import type { Transaction } from './session.service.js';
import type { GoogleIdentity } from './google-oidc.js';
import { signupEmail, signupName } from './signup-fields.js';

export const invalidGoogleFlow = () => new AppError(400, 'GOOGLE_FLOW_INVALID', 'Google sign-in expired or changed. Start again.');

export async function googleSignInAccount(tx: Transaction, { identity, observedLink }: GoogleCompletionProof) {
  const matchesIdentity = and(eq(googleIdentities.issuer, identity.issuer), eq(googleIdentities.subject, identity.subject));
  if (observedLink) {
    const [account] = await tx.select({ id: users.id, securityVersion: users.securityVersion, revision: users.googleLinkRevision })
      .from(users).where(eq(users.id, observedLink.userId)).for('update');
    if (!account || account.revision !== observedLink.revision) throw invalidGoogleFlow();
    const [link] = await tx.select({ userId: googleIdentities.userId }).from(googleIdentities)
      .where(and(eq(googleIdentities.userId, account.id), matchesIdentity));
    if (!link) throw invalidGoogleFlow();
    return { account, outcome: 'signed_in' as const };
  }

  const [existingLink] = await tx.select({ userId: googleIdentities.userId }).from(googleIdentities).where(matchesIdentity);
  if (existingLink) throw invalidGoogleFlow();
  const email = signupEmail.safeParse(identity.email);
  if (!identity.emailVerified || !email.success) {
    throw new AppError(400, 'GOOGLE_EMAIL_REQUIRED', 'Google could not provide a verified email. Create an account with a password.');
  }
  const name = signupName.safeParse(identity.name);
  const [account] = await tx.insert(users).values({
    email: email.data, fullName: name.success ? name.data : undefined, googleLinkRevision: 1,
  }).onConflictDoNothing({ target: users.email }).returning({ id: users.id, securityVersion: users.securityVersion });
  if (!account) {
    throw new AppError(409, 'GOOGLE_EMAIL_IN_USE', 'Sign in with your existing method, then link Google in Profile.');
  }
  const [link] = await tx.insert(googleIdentities).values({ userId: account.id, issuer: identity.issuer, subject: identity.subject })
    .onConflictDoNothing().returning({ userId: googleIdentities.userId });
  if (!link) throw invalidGoogleFlow();
  return { account, outcome: 'signed_up' as const };
}

// The attempt store holds the initiating account lock while applying the proof.
export async function linkGoogleAccount(tx: Transaction, userId: string, { issuer, subject }: GoogleIdentity) {
  const [inserted] = await tx.insert(googleIdentities).values({ userId, issuer, subject })
    .onConflictDoNothing().returning({ userId: googleIdentities.userId });
  if (inserted) {
    await tx.update(users).set({ googleLinkRevision: sql`${users.googleLinkRevision} + 1` }).where(eq(users.id, userId));
    return 'linked' as const;
  }

  const [existing] = await tx.select({ issuer: googleIdentities.issuer, subject: googleIdentities.subject })
    .from(googleIdentities).where(eq(googleIdentities.userId, userId));
  if (existing?.issuer === issuer && existing.subject === subject) return 'linked' as const;
  if (existing) return new AppError(409, 'GOOGLE_LINK_CONFLICT', 'This Neuton account already has a Google link.');
  return new AppError(409, 'GOOGLE_LINK_CONFLICT', 'This Google account is already linked to a Neuton account.');
}

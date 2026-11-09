import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { googleAttempts, preAuthContexts, type GoogleCompletionProof } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { digest, SessionService, validSecret, type SessionRecord, type Transaction } from './session.service.js';

const ATTEMPT_MS = 5 * 60_000;
const COMPLETION_MS = 60_000;
const MAX_ATTEMPTS = 3;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type GoogleAttemptBinding = { purpose: 'sign_in'; contextSecret: string }
  | { purpose: 'link'; session: SessionRecord };

type ClaimedAttempt = { stateDigest: string; nonce: string; verifier: string };

const opaque = () => randomBytes(32).toString('base64url');

export class GoogleAttemptStore {
  constructor(private readonly sessions: SessionService, private readonly flowKey: Buffer,
    private readonly clock?: () => Date) {}

  start(binding: GoogleAttemptBinding) {
    return this.sessions.transaction(async (tx) => {
      const owner = await this.lockBinding(tx, binding);
      if (!owner) return null;
      const { now } = owner;
      const outstanding = await tx.select({ stateDigest: googleAttempts.stateDigest }).from(googleAttempts)
        .where(and(owner.match, gt(googleAttempts.expiresAt, now))).limit(MAX_ATTEMPTS);
      if (outstanding.length >= MAX_ATTEMPTS) {
        throw new AppError(429, 'GOOGLE_ATTEMPT_LIMIT', 'Too many Google sign-in attempts. Try again shortly.');
      }
      const attempt = { state: opaque(), nonce: opaque(), verifier: opaque() };
      const stateDigest = digest(attempt.state);
      await tx.insert(googleAttempts).values({
        ...owner.values, stateDigest, nonce: attempt.nonce,
        encryptedVerifier: this.encrypt(attempt.verifier, stateDigest),
        expiresAt: new Date(Math.min(now.getTime() + ATTEMPT_MS, owner.expiresAt.getTime())),
      });
      return attempt;
    });
  }

  async claim(binding: GoogleAttemptBinding, state: string): Promise<ClaimedAttempt | null> {
    if (!validSecret(state)) return null;
    const stateDigest = digest(state);
    return this.sessions.transaction(async (tx) => {
      const owner = await this.lockBinding(tx, binding);
      if (!owner) return null;
      const [attempt] = await tx.select({ nonce: googleAttempts.nonce, encryptedVerifier: googleAttempts.encryptedVerifier })
        .from(googleAttempts).where(and(owner.match, eq(googleAttempts.stateDigest, stateDigest),
          gt(googleAttempts.expiresAt, owner.now))).for('update');
      if (!attempt?.encryptedVerifier || !attempt.nonce) return null;
      const verifier = this.decrypt(attempt.encryptedVerifier, stateDigest);
      await tx.update(googleAttempts).set({ encryptedVerifier: null, nonce: null })
        .where(eq(googleAttempts.stateDigest, stateDigest));
      return { stateDigest, nonce: attempt.nonce, verifier };
    });
  }

  finish(binding: GoogleAttemptBinding, claim: Pick<ClaimedAttempt, 'stateDigest'>, proof: GoogleCompletionProof | null) {
    return this.sessions.transaction(async (tx) => {
      const owner = await this.lockBinding(tx, binding);
      if (!owner) return null;
      const { now } = owner;
      const claimed = and(owner.match, eq(googleAttempts.stateDigest, claim.stateDigest), gt(googleAttempts.expiresAt, now),
        isNull(googleAttempts.encryptedVerifier), isNull(googleAttempts.completionDigest));
      if (!proof) {
        await tx.delete(googleAttempts).where(claimed);
        return null;
      }
      const completionId = opaque();
      const deadline = new Date(Math.min(now.getTime() + COMPLETION_MS, owner.expiresAt.getTime()));
      const [published] = await tx.update(googleAttempts).set({
        completionDigest: digest(completionId), completionProof: proof,
        expiresAt: sql`least(${googleAttempts.expiresAt}, ${deadline.toISOString()}::timestamptz)`,
      }).where(claimed).returning({ stateDigest: googleAttempts.stateDigest });
      return published ? completionId : null;
    });
  }

  async consume<T>(binding: GoogleAttemptBinding, completionId: string,
    apply: (tx: Transaction, proof: GoogleCompletionProof) => Promise<T>): Promise<T | null> {
    if (!validSecret(completionId)) return null;
    return this.sessions.transaction(async (tx) => {
      const owner = await this.lockBinding(tx, binding);
      if (!owner) return null;
      const [completion] = await tx.delete(googleAttempts).where(and(owner.match,
        eq(googleAttempts.completionDigest, digest(completionId)), gt(googleAttempts.expiresAt, owner.now)))
        .returning({ proof: googleAttempts.completionProof });
      if (!completion?.proof) return null;
      // Return expected terminal outcomes from apply so consumption commits with the account decision.
      return apply(tx, completion.proof);
    });
  }

  private async lockBinding(tx: Transaction, binding: GoogleAttemptBinding) {
    if (binding.purpose === 'link') {
      const { account, current, now } = await this.sessions.lockCurrent(tx, binding.session, () => this.currentTime(tx));
      return {
        now,
        match: and(eq(googleAttempts.sessionId, current.id), eq(googleAttempts.linkRevision, account.googleLinkRevision)),
        values: { sessionId: current.id, linkRevision: account.googleLinkRevision },
        expiresAt: new Date(Math.min(current.idleExpiresAt.getTime(), current.absoluteExpiresAt.getTime())),
      };
    }
    if (!validSecret(binding.contextSecret)) return null;
    const contextDigest = digest(binding.contextSecret);
    const [context] = await tx.select({ expiresAt: preAuthContexts.expiresAt }).from(preAuthContexts)
      .where(eq(preAuthContexts.secretDigest, contextDigest)).for('update');
    if (!context) return null;
    const now = await this.currentTime(tx);
    if (context.expiresAt <= now) return null;
    return { now, match: eq(googleAttempts.contextDigest, contextDigest), values: { contextDigest }, expiresAt: context.expiresAt };
  }

  private async currentTime(tx: Transaction) {
    if (this.clock) return this.clock();
    const [clock] = await tx.execute<{ time: string }>(sql`SELECT statement_timestamp() AS time`);
    return new Date(clock!.time);
  }

  private encrypt(verifier: string, stateDigest: string) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.flowKey, iv);
    cipher.setAAD(Buffer.from(stateDigest));
    const ciphertext = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  private decrypt(encrypted: string, stateDigest: string) {
    const data = Buffer.from(encrypted, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.flowKey, data.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(stateDigest));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}

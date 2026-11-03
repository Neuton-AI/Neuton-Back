import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../lib/errors.js';
import { isBearerSecret, isValidUnicode } from './normalization.js';

const unavailable = () => new AppError(503, 'AUTH_SECRET_UNAVAILABLE', 'Authentication secret unavailable');
const MAX_PAYLOAD_BYTES = 65_536;
export type SecretPurpose = 'session' | 'csrf' | 'browser_context' | 'oauth_state' | 'oauth_completion' |
  'confirm_email' | 'password_reset' | 'email_change';
export type EncryptionPurpose = 'oauth_pkce' | 'mail:confirm_email' | 'mail:password_reset' |
  'mail:email_change' | 'mail:security_notice';
export interface EncryptedPayload { keyId: string; ciphertext: string }

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function digestSecret(purpose: SecretPurpose, secret: string): string {
  if (!isBearerSecret(secret)) throw new Error('Invalid bearer secret');
  return createHash('sha256').update(JSON.stringify(['neuton-auth-secret-v1', purpose, secret])).digest('hex');
}

export function secretMatches(purpose: SecretPurpose, secret: string, digest: string): boolean {
  if (!isBearerSecret(secret) || !/^[a-f0-9]{64}$/.test(digest)) return false;
  return timingSafeEqual(Buffer.from(digestSecret(purpose, secret), 'hex'), Buffer.from(digest, 'hex'));
}

export function rateLimitDigest(key: Buffer, environment: string, dimension: string, value: string): string {
  if (key.length !== 32) throw unavailable();
  return createHmac('sha256', key)
    .update(JSON.stringify(['neuton-auth-rate-v1', environment, dimension, value])).digest('hex');
}

function decodePart(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (expectedBytes !== undefined && bytes.length !== expectedBytes)) {
    throw unavailable();
  }
  return bytes;
}

/** Only short-lived persisted secrets use reversible encryption, never passwords or session bearers. */
export class AuthEncryption {
  private readonly keys: Map<string, Buffer>;

  constructor(private readonly activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
    if (!keys.has(activeKeyId) || keys.size > 8) throw unavailable();
    this.keys = new Map();
    for (const [id, key] of keys) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || key.length !== 32) throw unavailable();
      this.keys.set(id, Buffer.from(key));
    }
  }

  encrypt(purpose: EncryptionPurpose, recordId: string, plaintext: string): EncryptedPayload {
    try {
      if (Buffer.byteLength(plaintext) > MAX_PAYLOAD_BYTES || !isValidUnicode(plaintext)) throw unavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, nonce, { authTagLength: 16 });
      cipher.setAAD(this.associatedData(this.activeKeyId, purpose, recordId));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const ciphertext = ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url')].join('.');
      return { keyId: this.activeKeyId, ciphertext };
    } catch {
      throw unavailable();
    }
  }

  decrypt(purpose: EncryptionPurpose, recordId: string, envelope: EncryptedPayload): string {
    try {
      const key = this.keys.get(envelope.keyId);
      if (!key || envelope.ciphertext.length > 87_424) throw unavailable();
      const parts = envelope.ciphertext.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw unavailable();
      const nonce = decodePart(parts[1]!, 12);
      const tag = decodePart(parts[2]!, 16);
      const encrypted = decodePart(parts[3]!);
      if (encrypted.length > MAX_PAYLOAD_BYTES) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      decipher.setAAD(this.associatedData(envelope.keyId, purpose, recordId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      throw unavailable();
    }
  }

  private associatedData(keyId: string, purpose: EncryptionPurpose, recordId: string): Buffer {
    if (!recordId || recordId.length > 128 || !isValidUnicode(recordId)) throw unavailable();
    return Buffer.from(JSON.stringify(['neuton-auth-encryption-v1', keyId, purpose, recordId]));
  }
}

import * as argon2 from 'argon2';
import { AUTH_POLICY } from '../../config/auth-policy.js';
import { AppError } from '../../lib/errors.js';
import { PasswordHasher } from './auth.ports.js';
import { validatePassword } from './normalization.js';

const options = Object.freeze({ type: argon2.argon2id, memoryCost: AUTH_POLICY.password.memoryCostKiB,
  timeCost: AUTH_POLICY.password.timeCost, parallelism: AUTH_POLICY.password.parallelism, version: 0x13 });
// Public synthetic comparison target, unrelated to any account or credential.
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=1$S04tyw074m/eXVryuv7liA$TI44HwWFmhrQ79vWkMQVmudNvCwgte6f/vzLMrdus80';
const unavailable = () => new AppError(503, 'AUTH_HASH_UNAVAILABLE', 'Password authentication temporarily unavailable');
let activeWork = 0;

export class ArgonPasswordHasher extends PasswordHasher {
  constructor(private readonly capacity: number = AUTH_POLICY.password.maxConcurrentHashes) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > AUTH_POLICY.password.maxConcurrentHashes) {
      throw unavailable();
    }
  }

  override async hash(password: string): Promise<string> {
    validatePassword(password);
    return this.run(() => argon2.hash(password, options));
  }

  override async verify(encodedHash: string, password: string): Promise<boolean> {
    validatePassword(password);
    return this.run(() => argon2.verify(encodedHash, password));
  }

  override async verifyDummy(password: string): Promise<void> {
    // Deliberately discard the result: a dummy comparison can never authenticate a user.
    await this.verify(DUMMY_HASH, password);
  }

  override needsRehash(encodedHash: string): boolean {
    try {
      return !encodedHash.startsWith('$argon2id$') || argon2.needsRehash(encodedHash, options);
    } catch {
      throw unavailable();
    }
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (activeWork >= this.capacity) throw unavailable();
    activeWork += 1;
    try {
      return await work();
    } catch {
      throw unavailable();
    } finally {
      activeWork -= 1;
    }
  }
}

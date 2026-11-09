import { argon2id, hash, verify } from 'argon2';

const options = { type: argon2id, memoryCost: 19_456, timeCost: 3, parallelism: 1 } as const;
const hashingConcurrency = 2;
let activeOperations = 0;
const waitingOperations: Array<() => void> = [];

// Spend comparable Argon2 work for unknown accounts and wrong passwords.
const dummyHash = '$argon2id$v=19$m=19456,t=3,p=1$d1SaxTQddg5Xq6hkXRsYZw$PofqKUz00Ua7rrFvcbTxjmjgPynPu4O963qR2lAohMU';

async function runHashOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  if (activeOperations < hashingConcurrency) {
    activeOperations++;
  } else {
    await new Promise<void>((resume) => waitingOperations.push(resume));
  }
  try {
    return await operation();
  } finally {
    const next = waitingOperations.shift();
    if (next) {
      next();
    } else {
      activeOperations--;
    }
  }
}

export function hashPassword(password: string): Promise<string> {
  return runHashOperation(() => hash(password, options));
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  const matches = await runHashOperation(() => verify(passwordHash ?? dummyHash, password));
  return passwordHash !== undefined && matches;
}

export function isLegacyPasswordHash(passwordHash: string): boolean {
  return passwordHash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$');
}

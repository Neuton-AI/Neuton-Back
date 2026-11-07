import { argon2id, hash, verify } from 'argon2';

const options = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
// Spend comparable Argon2 work for unknown accounts and wrong passwords.
const dummyHash = '$argon2id$v=19$m=19456,t=2,p=1$qR1P1V4aNho7vGeCFZOBxw$k13F3sSJiCYCYu/TysFtH2J9AnPMfPKvtz7xeuhpHGE';

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  const matches = await verify(passwordHash ?? dummyHash, password);
  return passwordHash !== undefined && matches;
}

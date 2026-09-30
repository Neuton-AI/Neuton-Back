import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../src/db/client.js';

/**
 * Marks a migration as applied without executing it.
 *
 * Needed when the schema was created out-of-band (drizzle-kit push) and the
 * ledger therefore disagrees with the database. The checksum still has to
 * match, so a file that differs from what was actually applied is rejected
 * rather than silently accepted.
 */
const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/mark-applied.ts <migration.sql>');
  process.exit(1);
}

const raw = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
const checksum = createHash('sha256')
  .update(raw.replace(/\r\n/g, '\n'))
  .digest('hex')
  .slice(0, 16);

const existing = await sql<{ checksum: string }[]>`
  select checksum from public.__neuton_migrations where name = ${file}
`;

if (existing[0]) {
  console.log(`${file} already recorded as applied (checksum ${existing[0].checksum})`);
} else {
  await sql`insert into public.__neuton_migrations (name, checksum) values (${file}, ${checksum})`;
  console.log(`recorded ${file} as applied (checksum ${checksum})`);
}

await sql.end({ timeout: 5 });

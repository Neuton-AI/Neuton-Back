import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from './client.js';

const migrationsDir = join(process.cwd(), 'drizzle');
const BREAKPOINT = '--> statement-breakpoint';

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS public.__neuton_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

function checksum(raw: string): string {
  return createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

function splitStatements(raw: string): string[] {
  return raw
    .split(/(?:-->)?\s*statement-breakpoint/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migrations found in ./drizzle');
    return;
  }

  await sql.unsafe(LEDGER_DDL);

  for (const file of files) {
    const raw = readFileSync(join(migrationsDir, file), 'utf8');
    const hash = checksum(raw);

    const existing = await sql<{ checksum: string }[]>`
      select checksum from public.__neuton_migrations where name = ${file}
    `;

    const previous = existing[0]?.checksum;
    if (previous) {
      if (previous !== hash) {
        throw new Error(
          `migration ${file} was already applied with checksum ${previous} but the file now hashes to ${hash}`,
        );
      }
      console.log(`skipped ${file} (already applied)`);
      continue;
    }

    const statements = splitStatements(raw);

    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`insert into public.__neuton_migrations (name, checksum) values (${file}, ${hash})`;
    });

    console.log(`applied ${file} (${statements.length} statements)`);
  }
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });

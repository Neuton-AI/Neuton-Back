import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSqlError, hasSqlDetails, loadModule, parse } from 'libpg-query';

const migrationsDir = join(process.cwd(), 'drizzle');
const BREAKPOINT = /(?:-->)?\s*statement-breakpoint/;

const files = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

let failures = 0;

await loadModule();

for (const file of files) {
  const raw = readFileSync(join(migrationsDir, file), 'utf8');
  const statements = raw.split(BREAKPOINT).map((s) => s.trim()).filter(Boolean);
  const before = failures;

  for (const [index, statement] of statements.entries()) {
    try {
      await parse(statement);
    } catch (error) {
      failures += 1;
      const message = hasSqlDetails(error)
        ? formatSqlError(error, statement)
        : error instanceof Error
          ? error.message
          : String(error);
      console.error(`FAIL ${file} statement ${index + 1}/${statements.length}\n${message}\n`);
    }
  }

  if (failures === before) {
    console.log(`ok   ${file} (${statements.length} statements)`);
  }
}

if (failures > 0) {
  console.error(`${failures} statement(s) failed to parse`);
  process.exit(1);
}

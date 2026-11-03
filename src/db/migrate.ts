import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigrationConnection } from './migration-client.js';
import { migrationChecksum, MigrationError, runMigrationBatch, validateMigrationHistory } from './migration-ledger.js';
import type { MigrationDatabase, MigrationFile } from './migration-ledger.js';

function loadMigrations(): MigrationFile[] {
  const directory = join(process.cwd(), 'drizzle-neon');
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const migrations = files.map(name => {
    const sql = readFileSync(join(directory, name), 'utf8');
    return { name, sql, checksum: migrationChecksum(sql) };
  });
  validateMigrationHistory(migrations, []);
  return migrations;
}

async function main(): Promise<void> {
  // Validate the local manifest before creating even a lazy database client.
  const migrations = loadMigrations();
  const connection = createMigrationConnection();
  const database: MigrationDatabase = {
    async transaction(work) {
      return connection.begin(async tx => {
        return work({
          async query<T extends Record<string, unknown>>(statement: string, parameters: string[] = []) {
            return [...await tx.unsafe<T[]>(statement, parameters)];
          },
          async execute(statement) { await tx.unsafe(statement); },
        });
      });
    },
  };
  try {
    const completed = await runMigrationBatch(database, migrations);
    for (const name of completed) console.log(`applied ${name}`);
    if (completed.length === 0) console.log('Neon migrations are current.');
  } finally {
    await connection.end({ timeout: 5 });
  }
}

main().catch(error => {
  if (error instanceof MigrationError) {
    console.error(error.message);
  } else {
    console.error('Neon migration failed. Check migration-only configuration, connectivity and the approved SQL chain.');
  }
  process.exitCode = 1;
});

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';

const encodedSettings = String.raw`^\$((?:argon2id|argon2i|argon2d)\$v=[0-9]{1,3}\$m=[0-9]{1,10},t=[0-9]{1,10},p=[0-9]{1,10})\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$`;

export async function countPasswordHashSettings(db: Database) {
  return [...await db.execute<{ settings: string; count: number }>(sql`
    select coalesce(substring(password_hash from ${encodedSettings}), 'unrecognized') as settings,
           count(*)::int as count
    from users
    group by 1
    order by 1
  `)];
}

async function main() {
  const { db, sql: connection } = await import('../src/db/client.js');
  try {
    console.log(JSON.stringify(await countPasswordHashSettings(db), null, 2));
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error('Could not read aggregate password hash settings.');
    process.exitCode = 1;
  });
}

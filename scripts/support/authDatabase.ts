import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import type { AuthTransaction } from '../../src/modules/auth/auth.ports.js';

export async function isolatedAuthDatabase() {
  const database = new PGlite();
  try {
    await database.exec(`create role neuton_app; create role neuton_auth; create role neuton_worker;
      create role neuton_cleanup; create role neuton_policy_reader nologin; create role neuton_bootstrap nologin`);
    const directory = new URL('../../drizzle-neon/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await database.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    const orm = drizzle(database);
    const auth = new AuthRepository({ transaction<T>(work: (transaction: AuthTransaction) => Promise<T>) {
      return orm.transaction(async transaction => {
        await transaction.execute(sql`set local role neuton_auth`);
        return work(transaction);
      });
    } });
    return { database, orm, auth };
  } catch (error) {
    await database.close();
    throw error;
  }
}

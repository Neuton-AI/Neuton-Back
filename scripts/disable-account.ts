import { config as loadDotenv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { createMigrationConnection } from '../src/db/migration-client.js';
import { AuthRepository } from '../src/modules/auth/auth.repository.js';
import { AccountAdministrationService } from '../src/modules/auth/account-administration.service.js';
import { SecurityEvents } from '../src/modules/auth/security-events.js';

async function main() {
  const [operation, userId, correlationId, ...extra] = process.argv.slice(2);
  if (operation !== 'disable' || extra.length || !z.string().uuid().safeParse(userId).success ||
    !z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).safeParse(correlationId).success) {
    throw new Error('Usage: npm run account:disable -- disable <user-uuid> <operator-correlation-id>');
  }
  // Possession of the separately managed migration/operator credential is the administrative boundary.
  // No runtime-role fallback, HTTP route, shop role, user-supplied status, or re-enable operation.
  loadDotenv({ quiet: true });
  const connection = createMigrationConnection();
  try {
    const administration = new AccountAdministrationService(new AuthRepository(drizzle(connection)), new SecurityEvents());
    const changed = await administration.disable(userId!, correlationId!);
    console.log(changed ? 'Account disabled; security state revoked.' : 'Account was already disabled.');
  } finally { await connection.end({ timeout: 5 }); }
}
main().catch(() => {
  console.error('Account disablement was not confirmed. Check operator access, arguments and account ID.');
  process.exitCode = 1;
});

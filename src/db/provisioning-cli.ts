import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { readProvisioningRoles } from './provisioning.js';

/** Read an owner credential interactively without echoing it or retaining input history. */
export async function promptMigrationUrl(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Invalid authentication configuration: MIGRATION_DATABASE_URL');
  }
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) {
    if (!hidden) stdout.write(chunk);
    done();
  } });
  const terminal = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  try {
    const answer = new Promise<string>((resolve, reject) => {
      terminal.once('close', () => reject(new Error('Provisioning cancelled')));
      terminal.once('SIGINT', () => terminal.close());
      terminal.question('Paste the existing Neon OWNER connection string (input hidden): ', resolve);
      hidden = true;
    });
    return (await answer).trim();
  } finally {
    terminal.close();
    stdout.write('\n');
  }
}

/** Never print arbitrary driver errors: they may contain connection credentials or SQL. */
export function provisioningFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Invalid authentication configuration: MIGRATION_DATABASE_URL') {
    return 'Provide a valid PostgreSQL OWNER connection string. Supported URL options are sslmode, sslrootcert=system and channel_binding=require. In a noninteractive shell, export MIGRATION_DATABASE_URL first.';
  }
  if (message === 'Role provisioning requires an empty application database') {
    return 'The selected database already contains application tables. Select the fresh, empty migration database.';
  }
  if (message === 'Provisioning cancelled') return 'Role provisioning cancelled.';
  for (const role of readProvisioningRoles()) {
    if (message === `Unsafe existing database role: ${role.name}`) {
      return `Existing role ${role.name} has incompatible privileges or ownership. No changes were committed.`;
    }
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'CHANNEL_BINDING_REQUIRED') return 'The endpoint did not complete required channel-bound authentication. Verify the selected Neon endpoint supports SCRAM-SHA-256-PLUS.';
  if (code === '42501') return 'The owner connection lacks permission to create roles or configure database privileges.';
  if (code === '28P01') return 'Neon rejected the owner username or password.';
  if (['ENOTFOUND', 'ECONNREFUSED', 'CONNECT_TIMEOUT'].includes(String(code))) {
    return 'Could not connect to Neon. Check the owner endpoint and network connection.';
  }
  return 'Role provisioning failed. Check the owner connection, database permissions and existing role privileges. No credentials were logged.';
}

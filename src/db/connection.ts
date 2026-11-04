import postgres from 'postgres';
import { databaseUrl } from '../config/database.js';
import type { EnvironmentSource } from '../config/database.js';

const CONNECTION_ROLES = {
  app: { field: 'DATABASE_URL', role: 'neuton_app' },
  auth: { field: 'AUTH_DATABASE_URL', role: 'neuton_auth' },
  worker: { field: 'WORKER_DATABASE_URL', role: 'neuton_worker' },
  cleanup: { field: 'CLEANUP_DATABASE_URL', role: 'neuton_cleanup' },
  migration: { field: 'MIGRATION_DATABASE_URL', role: undefined },
} as const;

/** Shared by runtime pools, provisioning and the dedicated notification connection. */
export function databaseTransportOptions() {
  return {
    ssl: { rejectUnauthorized: true },
    channel_binding: 'require' as const,
    // Preserve v3 parameter typing while upgrading transport and authentication.
    infer: true,
    prepare: false,
  };
}

export function createDatabaseConnection(
  purpose: keyof typeof CONNECTION_ROLES,
  source: EnvironmentSource = process.env,
): postgres.Sql {
  const setting = CONNECTION_ROLES[purpose];
  const url = databaseUrl(source, setting.field, setting.role);
  const migration = purpose === 'migration';
  return postgres(url, {
    ...databaseTransportOptions(),
    max: migration ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 15,
    connection: { application_name: `neuton-${purpose}`,
      statement_timeout: migration ? 300_000 : 30_000,
      idle_in_transaction_session_timeout: 30_000 },
    onnotice: () => {},
  });
}

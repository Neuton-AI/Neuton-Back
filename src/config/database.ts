export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
export type DatabaseProcess = 'api' | 'worker' | 'cleanup' | 'migration';

export function invalidConfig(field: string): never {
  throw new Error(`Invalid authentication configuration: ${field}`);
}

export function requiredSetting(source: EnvironmentSource, field: string): string {
  const value = source[field];
  if (!value || !value.trim()) invalidConfig(field);
  return value;
}

export function databaseUrl(source: EnvironmentSource, field: string, role?: string): string {
  const value = requiredSetting(source, field);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfig(field);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname ||
    !parsed.username || !parsed.password || parsed.pathname.length < 2 || parsed.hash) {
    invalidConfig(field);
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    invalidConfig(field);
  }
  if (role && username !== role) invalidConfig(field);
  const runtimeRoles = ['neuton_app', 'neuton_auth', 'neuton_worker', 'neuton_cleanup', 'neuton_policy_reader', 'neuton_bootstrap', 'neuton_maintenance'];
  if (!role && runtimeRoles.includes(username)) invalidConfig(field);
  // postgres-js forwards unknown URL parameters as startup settings; those
  // must not override the validated user, database, role or connection policy.
  for (const key of parsed.searchParams.keys()) {
    if (!['sslmode', 'sslrootcert'].includes(key) || parsed.searchParams.getAll(key).length !== 1) {
      invalidConfig(field);
    }
  }
  const rootCertificate = parsed.searchParams.get('sslrootcert');
  if (rootCertificate && rootCertificate !== 'system') invalidConfig(field);
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
    invalidConfig(field);
  }
  return value;
}

export function readProcessDatabase<P extends Exclude<DatabaseProcess, 'api'>>(
  process: P, source: EnvironmentSource,
): { process: P; databaseUrl: string } {
  if (process === 'migration') {
    return { process, databaseUrl: databaseUrl(source, 'MIGRATION_DATABASE_URL') };
  }
  if (process === 'worker') {
    return { process, databaseUrl: databaseUrl(source, 'WORKER_DATABASE_URL', 'neuton_worker') };
  }
  return { process, databaseUrl: databaseUrl(source, 'CLEANUP_DATABASE_URL', 'neuton_cleanup') };
}

/** Keep existing direct-only setups working while rejecting Neon's transaction pooler. */
export function resolveDirectDatabaseUrl(databaseUrl: string, directDatabaseUrl?: string): string {
  const url = directDatabaseUrl?.trim() || databaseUrl;
  const hostname = URL.canParse(url) ? new URL(url).hostname : '';
  if (hostname.endsWith('.neon.tech') && hostname.split('.')[0]?.endsWith('-pooler')) {
    throw new Error('Set DIRECT_DATABASE_URL to a direct Neon connection URL (without -pooler).');
  }
  return url;
}

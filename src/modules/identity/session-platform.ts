export function platformFromUserAgent(userAgent: string | string[] | undefined): string {
  const header = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  const agent = header ?? '';
  if (/iPad/.test(agent)) return 'iPad';
  if (/iPhone|iPod/.test(agent)) return 'iPhone';
  if (/Android/.test(agent)) return 'Android';
  if (/Windows/.test(agent)) return 'Windows';
  if (/CrOS/.test(agent)) return 'Chromebook';
  if (/Macintosh/.test(agent)) return 'Mac';
  if (/Linux/.test(agent)) return 'Linux';
  return 'Unknown';
}

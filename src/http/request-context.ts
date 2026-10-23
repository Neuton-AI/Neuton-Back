import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Logger } from '../lib/logger/types.js';

export interface HttpRequest extends Request {
  requestId: string;
  traceId: string;
  log: Logger;
}

export function resolveTraceId(headers: Request['headers']): string {
  const explicit = headers['x-trace-id'];
  if (typeof explicit === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(explicit)) return explicit;
  const parent = headers.traceparent;
  if (typeof parent === 'string') {
    const match = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(parent);
    if (match?.[1] && !/^0+$/.test(match[1])) return match[1];
  }
  return randomUUID();
}

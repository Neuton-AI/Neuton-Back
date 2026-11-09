import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env, sessionOrigin } from '../../env.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import type { SessionRecord } from './session.service.js';

export const sessionOrigins = sessionOrigin ? [sessionOrigin] : [];
if (env.NODE_ENV === 'development' && !sessionOrigin) {
  sessionOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173');
}
const secure = !sessionOrigins.some((origin) => origin.startsWith('http://'));
const options = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
const sessionName = secure ? '__Host-neuton-session' : 'neuton-session-local';
const contextName = secure ? '__Host-neuton-context' : 'neuton-context-local';

function readCookie(request: Request, name: string) {
  let value: string | undefined;
  for (const part of request.headers.cookie?.split(';') ?? []) {
    const [key, ...parts] = part.trim().split('=');
    if (key !== name) continue;
    if (value !== undefined || parts.length !== 1) return undefined;
    value = parts[0];
  }
  return value;
}

export const sessionSecret = (request: Request) => readCookie(request, sessionName);
export const contextSecret = (request: Request) => readCookie(request, contextName);

export function setSessionCookie(response: Response, secret: string, session: SessionRecord) {
  const expires = new Date(Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()));
  response.cookie(sessionName, secret, { ...options, expires });
}

export function setContextCookie(response: Response, secret: string, expires: Date) {
  response.cookie(contextName, secret, { ...options, expires });
}

export const clearSessionCookie = (response: Response) => response.clearCookie(sessionName, options);
export const clearContextCookie = (response: Response) => response.clearCookie(contextName, options);

export function requireOrigin(request: Request) {
  if (!request.headers.origin || !sessionOrigins.includes(request.headers.origin)) {
    throw forbidden('Origin not allowed');
  }
}

export function requireJson(request: Request) {
  if (!request.is('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
}

export function csrfProof(secret: string, kind: 'session' | 'context') {
  return createHmac('sha256', secret).update(`neuton-csrf:${kind}`).digest('base64url');
}

export function requireProof(request: Request, secret: string, kind: 'session' | 'context') {
  const proof = request.headers['x-csrf-token'];
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
    !timingSafeEqual(Buffer.from(proof), Buffer.from(csrfProof(secret, kind)))) {
    throw forbidden('Invalid CSRF proof');
  }
}

export function protectSessionMutation(request: Request, secret: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  requireOrigin(request);
  requireProof(request, secret, 'session');
  const bodyLength = Number(request.headers['content-length']);
  if (bodyLength > 0 || request.headers['transfer-encoding']) requireJson(request);
}

export function requireMatchingSession(request: Request, sessionId: string) {
  const expected = request.headers['x-session-id'];
  if (expected !== undefined && expected !== sessionId) throw unauthorized('Session changed');
}

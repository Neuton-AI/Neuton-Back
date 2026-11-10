import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import type { HttpRequest } from '../../http/request-context.js';
import { AppError, forbidden, unauthorized } from '../../lib/errors.js';
import { SessionService, sessionMetadata } from './session.service.js';
import { existingPasswordSchema, newPasswordSchema } from './password-policy.js';
import { GoogleFlowService } from './google-flow.service.js';
import type { GoogleAttemptBinding } from './google-attempts.js';
import { signupEmail, signupName } from './signup-fields.js';
import {
  clearContextCookie, clearSessionCookie, contextSecret, csrfProof, protectSessionMutation,
  requireJson, requireMatchingSession, requireOrigin, requireProof, sessionSecret, setContextCookie, setSessionCookie,
} from './session-http.js';

const signinSchema = z.object({
  email: signupEmail,
  password: existingPasswordSchema,
});

const signupSchema = signinSchema.extend({
  password: newPasswordSchema,
  fullName: signupName.optional(),
});

const googleStartSchema = z.object({ purpose: z.enum(['sign_in', 'link']) }).strict();
const googleCompleteSchema = googleStartSchema.partial().extend({
  completionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const googleCallbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(2048).optional(),
  error: z.string().min(1).max(128).optional(),
});

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(GoogleFlowService) private readonly google: GoogleFlowService | null,
  ) {}

  @Post('csrf') @HttpCode(200)
  async csrf(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    requireOrigin(request);
    const session = sessionSecret(request);
    if (session && await this.sessions.resolve(session)) return { token: csrfProof(session, 'session') };
    const context = contextSecret(request);
    if (context && await this.sessions.contextExists(context)) return { token: csrfProof(context, 'context') };
    const created = await this.sessions.createContext();
    setContextCookie(response, created.secret, created.expires);
    return { token: csrfProof(created.secret, 'context') };
  }

  @Get('google/status')
  googleStatus() { return { enabled: this.google !== null }; }

  @Post('google/start') @HttpCode(200)
  async startGoogle(@Req() request: HttpRequest, @Body() body: unknown) {
    requireOrigin(request);
    requireJson(request);
    if (!this.google) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Google sign-in is temporarily unavailable');
    const { purpose } = googleStartSchema.parse(body);
    if (purpose === 'link') {
      const { session } = await this.current(request);
      return this.google.start({ purpose, session });
    }
    return this.google.start(await this.googleSignInBinding(request));
  }

  @Get('google/callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async googleCallback(@Req() request: HttpRequest, @Res() response: Response, @Query() query: unknown) {
    if (request.method !== 'GET') {
      response.status(405).set('Allow', 'GET').end();
      return;
    }
    let page = '/signin';
    let outcome = 'retry';
    let completionId: string | undefined;
    let link = false;
    const parsed = googleCallbackSchema.safeParse(query);
    try {
      if (!this.google) {
        outcome = 'unavailable';
      } else if (parsed.success) {
        const session = await this.sessions.resolve(sessionSecret(request));
        const context = contextSecret(request);
        let binding: GoogleAttemptBinding | undefined;
        if (session) {
          page = '/profile';
          binding = { purpose: 'link', session };
        } else if (context) {
          binding = { purpose: 'sign_in', contextSecret: context };
        }
        if (binding) {
          const result = await this.google.callback(binding, parsed.data);
          if ('completionId' in result) {
            outcome = 'ready';
            completionId = result.completionId;
            link = binding.purpose === 'link';
          } else {
            outcome = result.error;
          }
        }
      }
    } catch (error) {
      outcome = error instanceof AppError && error.statusCode < 500 ? 'retry' : 'unavailable';
    }
    request.log.info({ event: 'google_callback', outcome }, 'Google callback processed');
    let destination = `${page}?google=${outcome}`;
    if (completionId) {
      const fragment = new URLSearchParams({ completionId });
      if (link) fragment.set('purpose', 'link');
      destination = `/auth/complete#${fragment}`;
    }
    response.status(303).set('Location', destination).end();
  }

  private async googleSignInBinding(request: HttpRequest) {
    if (await this.sessions.resolve(sessionSecret(request))) {
      throw new AppError(409, 'GOOGLE_SESSION_CHANGED', 'Your session changed. Start Google sign-in again.');
    }
    const secret = contextSecret(request);
    if (!secret) throw forbidden('Browser context expired');
    requireProof(request, secret, 'context');
    return { purpose: 'sign_in' as const, contextSecret: secret };
  }

  @Post('google/complete') @HttpCode(200)
  async completeGoogle(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    requireOrigin(request);
    requireJson(request);
    if (!this.google) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Google sign-in is temporarily unavailable');
    const { completionId, purpose } = googleCompleteSchema.parse(body);
    if (purpose === 'link') {
      const { session } = await this.current(request);
      const outcome = await this.google.completeLink({ purpose, session }, completionId);
      request.log.info({ event: 'google_link_completed', userId: session.userId }, 'Google link completed');
      return { outcome, destination: '/profile' };
    }
    const { outcome, secret, session } = await this.google.completeSignIn(await this.googleSignInBinding(request), completionId);
    setSessionCookie(response, secret, session);
    clearContextCookie(response);
    request.log.info({ event: 'google_sign_in_completed', outcome, userId: session.userId, sessionId: session.id }, 'Google sign-in completed');
    return { outcome, destination: '/dashboard' };
  }

  @Delete('google/link') @HttpCode(204)
  async unlinkGoogle(@Req() request: HttpRequest) {
    const { session } = await this.current(request);
    const { linkRemoved, revokedSessions } = await this.auth.unlinkGoogle(session);
    if (linkRemoved || revokedSessions > 0) {
      request.log.info({ event: 'google_unlink_completed', userId: session.userId, linkRemoved, revokedSessions }, 'Google unlink completed');
    }
  }

  private async credentialProof(request: HttpRequest) {
    requireOrigin(request);
    requireJson(request);
    const session = sessionSecret(request);
    if (session && await this.sessions.resolve(session)) {
      requireProof(request, session, 'session');
      return;
    }
    const context = contextSecret(request);
    if (!context || !await this.sessions.contextExists(context)) throw forbidden('Browser context expired');
    requireProof(request, context, 'context');
    return context;
  }

  private async current(request: HttpRequest) {
    const secret = sessionSecret(request);
    const session = await this.sessions.resolve(secret);
    if (!secret || !session) throw unauthorized();
    requireMatchingSession(request, session.id);
    protectSessionMutation(request, secret);
    return { secret, session };
  }

  @Post('signup')
  @Header('Cache-Control', 'no-store')
  async signup(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    const context = await this.credentialProof(request);
    const { user, secret, session } = await this.auth.signup(signupSchema.parse(body), context);
    setSessionCookie(response, secret, session);
    clearContextCookie(response);
    request.log.info({ event: 'session_created', userId: user.id, sessionId: session.id }, 'Session created');
    return { user };
  }

  @Post('signin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async signin(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    const context = await this.credentialProof(request);
    const sourceIp = request.ip ?? request.socket.remoteAddress;
    const { user, secret, session } = await this.auth.signin(
      signinSchema.parse(body), sourceIp && ipKeyGenerator(sourceIp, 128), context,
    );
    setSessionCookie(response, secret, session);
    clearContextCookie(response);
    request.log.info({ event: 'session_created', userId: user.id, sessionId: session.id }, 'Session created');
    return { user };
  }

  @Post('password/add') @HttpCode(204)
  async addPassword(@Req() request: HttpRequest, @Body() body: unknown) {
    const { session } = await this.current(request);
    const { newPassword } = z.object({ newPassword: newPasswordSchema }).strict().parse(body);
    await this.auth.addPassword(session, newPassword);
    request.log.info({ event: 'password_added', userId: session.userId }, 'First password added');
  }

  @Post('session/renew') @HttpCode(200)
  async renew(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const { secret, session } = await this.current(request);
    const { session: renewed, extended } = await this.sessions.renew(session);
    if (extended) {
      setSessionCookie(response, secret, renewed);
      request.log.info({ event: 'session_renewed', userId: session.userId, sessionId: session.id }, 'Session renewed');
    }
    return sessionMetadata(renewed);
  }

  @Get('sessions')
  async list(@Req() request: HttpRequest) {
    const { session } = await this.current(request);
    return { sessions: await this.sessions.list(session) };
  }

  @Post('logout') @HttpCode(204)
  async logout(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.current(request);
    await this.sessions.revoke(session, session.id);
    clearSessionCookie(response);
    request.log.info({ event: 'session_revoked', userId: session.userId, sessionId: session.id, reason: 'current' }, 'Session revoked');
  }

  @Post('logout-all') @HttpCode(204)
  async logoutAll(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.current(request);
    await this.sessions.revokeAll(session);
    clearSessionCookie(response);
    request.log.info({ event: 'sessions_revoked', userId: session.userId, sessionId: session.id }, 'All sessions revoked');
  }

  @Delete('sessions/:id') @HttpCode(204)
  async revoke(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    const { session } = await this.current(request);
    const target = z.string().uuid().parse(id).toLowerCase();
    const revoked = await this.sessions.revoke(session, target);
    if (target === session.id) clearSessionCookie(response);
    if (revoked) {
      request.log.info({ event: 'session_revoked', userId: session.userId, sessionId: target, reason: 'targeted' }, 'Session revoked');
    }
  }
}

import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { AuthService } from './auth.service.js';
import type { HttpRequest } from '../../http/request-context.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { SessionService, sessionMetadata } from './session.service.js';
import { existingPasswordSchema, newPasswordSchema } from './password-policy.js';
import {
  clearContextCookie, clearSessionCookie, contextSecret, csrfProof, protectSessionMutation,
  requireJson, requireMatchingSession, requireOrigin, requireProof, sessionSecret, setContextCookie, setSessionCookie,
} from './session-http.js';

const signinSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  password: existingPasswordSchema,
});

const signupSchema = signinSchema.extend({
  password: newPasswordSchema,
  fullName: htmlFree(z.string().trim().min(1).max(120)).optional(),
});

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
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
    await this.credentialProof(request);
    const { user, secret, session } = await this.auth.signup(signupSchema.parse(body));
    setSessionCookie(response, secret, session);
    clearContextCookie(response);
    request.log.info({ event: 'session_created', userId: user.id, sessionId: session.id }, 'Session created');
    return { user };
  }

  @Post('signin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async signin(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    await this.credentialProof(request);
    const sourceIp = request.ip ?? request.socket.remoteAddress;
    const { user, secret, session } = await this.auth.signin(
      signinSchema.parse(body), sourceIp && ipKeyGenerator(sourceIp, 128),
    );
    setSessionCookie(response, secret, session);
    clearContextCookie(response);
    request.log.info({ event: 'session_created', userId: user.id, sessionId: session.id }, 'Session created');
    return { user };
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

import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { HttpRequest } from '../../http/request-context.js';
import { unauthorized } from '../../lib/errors.js';
import { AuthCookies } from './cookies.js';
import { SessionService } from './session.service.js';
import { SessionProjection } from './session-projection.js';

@Controller('api/v1')
export class SessionController {
  constructor(@Inject(AuthCookies) private readonly cookies: AuthCookies, @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionProjection) private readonly projection: SessionProjection) {}
  private secret(request: HttpRequest): string {
    const secret = this.cookies.read('session', request.headers.cookie);
    if (!secret) throw unauthorized();
    return secret;
  }
  @Get('session') inspect(@Req() request: HttpRequest) { return this.projection.inspect(this.secret(request)); }
  @Post('auth/session/renew') @HttpCode(204)
  async renew(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(request.body ?? {});
    const secret = this.secret(request);
    const result = await this.sessions.renew(secret, request.traceId, request.headers['x-client-user-id']);
    response.setHeader('Set-Cookie', this.cookies.set('session', secret, result.idleExpiresAt));
  }
  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(request.body ?? {});
    await this.sessions.logout(this.secret(request), request.traceId, this.cookies.read('browser', request.headers.cookie), request.headers['x-client-user-id']);
    response.setHeader('Set-Cookie', [this.cookies.clear('session'), this.cookies.clear('browser')]);
  }
  @Post('auth/logout-all') @HttpCode(204)
  async logoutAll(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(request.body ?? {});
    await this.sessions.logoutAll(this.secret(request), request.traceId, this.cookies.read('browser', request.headers.cookie), request.headers['x-client-user-id']);
    response.setHeader('Set-Cookie', [this.cookies.clear('session'), this.cookies.clear('browser')]);
  }
  @Get('auth/sessions')
  list(@Req() request: HttpRequest) {
    return this.sessions.list(this.secret(request), request.headers['x-client-user-id']);
  }
  @Delete('auth/sessions/:id') @HttpCode(204)
  async revokeDevice(@Param('id') id: string, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(request.body ?? {});
    const sessionId = z.string().uuid().parse(id).toLowerCase();
    const result = await this.sessions.revokeDevice(this.secret(request), sessionId, request.traceId, request.headers['x-client-user-id']);
    if (result.current) {
      response.setHeader('Set-Cookie', [this.cookies.clear('session'), this.cookies.clear('browser')]);
    }
  }
}

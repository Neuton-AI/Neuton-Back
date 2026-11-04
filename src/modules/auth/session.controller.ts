import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
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
    const result = await this.sessions.renew(secret, request.traceId);
    response.setHeader('Set-Cookie', this.cookies.set('session', secret, result.idleExpiresAt));
  }
  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(request.body ?? {});
    await this.sessions.logout(this.secret(request), request.traceId, this.cookies.read('browser', request.headers.cookie));
    response.setHeader('Set-Cookie', [this.cookies.clear('session'), this.cookies.clear('browser')]);
  }
}

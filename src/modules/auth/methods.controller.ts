import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { HttpRequest } from '../../http/request-context.js';
import { unauthorized } from '../../lib/errors.js';
import { AuthCookies } from './cookies.js';
import { MethodsService } from './methods.service.js';
import { authPasswordSchema } from './contracts.js';
import { authRequestContext } from './auth.controller.js';

@Controller('api/v1/auth')
export class MethodsController {
  constructor(@Inject(MethodsService) private readonly methods: MethodsService, @Inject(AuthCookies) private readonly cookies: AuthCookies) {}

  private secret(request: HttpRequest): string {
    const secret = this.cookies.read('session', request.headers.cookie);
    if (!secret) throw unauthorized();
    return secret;
  }

  @Get('methods')
  list(@Req() request: HttpRequest) {
    return this.methods.list(this.secret(request), request.headers['x-client-user-id']);
  }

  @Post('password/add') @HttpCode(204)
  async addPassword(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    const input = z.object({ newPassword: authPasswordSchema }).strict().parse(body);
    const session = await this.methods.addPassword(this.secret(request), input.newPassword, authRequestContext(request), request.headers['x-client-user-id']);
    response.setHeader('Set-Cookie', this.cookies.set('session', session.secret, session.expiresAt));
  }

  @Delete('methods/google') @HttpCode(204)
  async unlink(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    z.object({}).strict().parse(body ?? {});
    const session = await this.methods.unlinkGoogle(this.secret(request), authRequestContext(request), request.headers['x-client-user-id']);
    response.setHeader('Set-Cookie', this.cookies.set('session', session.secret, session.expiresAt));
  }
}

import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { authRequestContext } from './auth.controller.js';
import { AuthCookies } from './cookies.js';
import { GoogleLoginService } from './google-login.service.js';

@Controller('api/v1/auth/google')
export class GoogleController {
  constructor(@Inject(GoogleLoginService) private readonly google: GoogleLoginService,
    @Inject(AuthCookies) private readonly cookies: AuthCookies) {}

  @Post('start') @HttpCode(200)
  async start(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.google.start(body, { browserSecret: this.cookies.read('browser', request.headers.cookie),
      sessionSecret: this.cookies.read('session', request.headers.cookie) }, authRequestContext(request));
    response.setHeader('Set-Cookie', this.cookies.set('browser', result.browser.secret, result.browser.expiresAt));
    return { authorizationUrl: result.authorizationUrl };
  }
}

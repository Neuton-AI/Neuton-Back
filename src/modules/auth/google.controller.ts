import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { authRequestContext } from './auth.controller.js';
import { AuthCookies } from './cookies.js';
import { GoogleLoginService } from './google-login.service.js';
import { AUTH_BROWSER_CONFIG } from './cookies.js';
import type { BrowserConfig } from './cookies.js';
import { AppError } from '../../lib/errors.js';
import { z } from 'zod';
import { isBearerSecret } from './normalization.js';

@Controller('api/v1/auth/google')
export class GoogleController {
  constructor(@Inject(GoogleLoginService) private readonly google: GoogleLoginService,
    @Inject(AuthCookies) private readonly cookies: AuthCookies,
    @Inject(AUTH_BROWSER_CONFIG) private readonly config: BrowserConfig) {}

  @Post('complete') @HttpCode(200)
  async complete(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const input = z.object({ ticket: z.string().refine(isBearerSecret) }).strict().parse(body);
    const result = await this.google.complete(input.ticket, this.cookies.read('browser', request.headers.cookie),
      this.cookies.read('session', request.headers.cookie), authRequestContext(request));
    response.setHeader('Set-Cookie', this.cookies.set('session', result.session.secret, result.session.expiresAt));
    return { returnPath: result.returnPath, purpose: result.purpose };
  }

  @Get('callback')
  async callback(@Req() request: HttpRequest, @Res() response: Response): Promise<void> {
    const callback = new URL('/api/v1/auth/google/callback', this.config.origin);
    callback.search = new URL(request.originalUrl, this.config.origin).search;
    try {
      const redirect = await this.google.callback(callback, this.cookies.read('browser', request.headers.cookie), authRequestContext(request));
      response.redirect(303, redirect);
    } catch (error) {
      const redirect = new URL('/auth/google/complete', this.config.origin);
      let code = 'GOOGLE_AUTH_FAILED';
      if (error instanceof AppError && ['GOOGLE_EMAIL_COLLISION', 'GOOGLE_ALREADY_LINKED'].includes(error.code)) code = error.code;
      redirect.hash = `error=${code}`;
      response.redirect(303, redirect.href);
    }
  }

  @Post('start') @HttpCode(200)
  async start(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.google.start(body, { browserSecret: this.cookies.read('browser', request.headers.cookie),
      sessionSecret: this.cookies.read('session', request.headers.cookie) }, authRequestContext(request));
    response.setHeader('Set-Cookie', this.cookies.set('browser', result.browser.secret, result.browser.expiresAt));
    return { authorizationUrl: result.authorizationUrl };
  }
}

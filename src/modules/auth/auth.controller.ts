import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HttpRequest } from '../../http/request-context.js';
import { AccountService } from './account.service.js';
import { PasswordService } from './password.service.js';
import { AuthCookies } from './cookies.js';
import { registrationInput, loginInput, emailInput, actionInput } from './contracts.js';
import type { AuthRequestContext } from './account.service.js';

export function authRequestContext(request: HttpRequest): AuthRequestContext {
  return { ip: request.ip ?? 'unknown', traceId: request.traceId, userAgent: request.headers['user-agent'] };
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AccountService) private readonly accounts: AccountService,
    @Inject(PasswordService) private readonly passwords: PasswordService, @Inject(AuthCookies) private readonly cookies: AuthCookies) {}

  @Post('register') @HttpCode(202)
  async register(@Body() body: unknown, @Req() request: HttpRequest): Promise<void> {
    await this.accounts.register(registrationInput.parse(body), authRequestContext(request));
  }
  @Post('login') @HttpCode(204)
  async login(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    const result = await this.passwords.login(loginInput.parse(body), authRequestContext(request));
    response.setHeader('Set-Cookie', this.cookies.set('session', result.secret, result.expiresAt));
  }
  @Post('email/resend') @HttpCode(202)
  async resend(@Body() body: unknown, @Req() request: HttpRequest): Promise<void> {
    await this.accounts.resend(emailInput.parse(body).email.normalized, authRequestContext(request));
  }
  @Post('email/confirm') @HttpCode(204)
  async confirm(@Body() body: unknown, @Req() request: HttpRequest): Promise<void> {
    await this.accounts.confirm(actionInput.parse(body).token, authRequestContext(request));
  }
}

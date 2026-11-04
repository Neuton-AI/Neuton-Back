import { Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CsrfService } from './csrf.service.js';
import { AuthRateLimitGuard } from './rate-limit.guard.js';

@Controller('api/v1/auth')
export class CsrfController {
  constructor(@Inject(CsrfService) private readonly csrf: CsrfService) {}
  @Post('csrf') @HttpCode(200) @UseGuards(AuthRateLimitGuard)
  async bootstrap(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    z.object({}).strict().parse(request.body ?? {});
    const result = await this.csrf.bootstrap(request.headers);
    if (result.cookies.length > 0) response.setHeader('Set-Cookie', result.cookies);
    response.setHeader('Cache-Control', 'no-store');
    return { csrfToken: result.csrfToken };
  }
}

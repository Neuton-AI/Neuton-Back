import { Body, Controller, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { AuthService } from './auth.service.js';

const signinSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  password: z.string().min(1).max(128),
});

const signupSchema = signinSchema.extend({
  password: z.string().min(15).max(128),
  fullName: htmlFree(z.string().trim().min(1).max(120)).optional(),
});

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('signup')
  @Header('Cache-Control', 'no-store')
  signup(@Body() body: unknown) {
    return this.auth.signup(signupSchema.parse(body));
  }

  @Post('signin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  signin(@Body() body: unknown) {
    return this.auth.signin(signinSchema.parse(body));
  }
}

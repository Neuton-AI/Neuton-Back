import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { AuthRateLimits } from './rate-limit.service.js';

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(@Inject(AuthRateLimits) private readonly limits: AuthRateLimits) {}
  async canActivate(): Promise<boolean> { await this.limits.global(); return true; }
}

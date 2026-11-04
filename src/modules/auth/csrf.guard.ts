import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfService } from './csrf.service.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(CsrfService) private readonly csrf: CsrfService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (request.method === 'POST' && request.path === '/api/v1/auth/csrf') return true;
    await this.csrf.verify(request.headers);
    return true;
  }
}

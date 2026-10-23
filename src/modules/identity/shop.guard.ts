import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { ActorRequest } from './actor-request.js';
import { IdentityService } from './identity.service.js';

@Injectable()
export class ShopGuard implements CanActivate {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ActorRequest>();
    const shopHeader = request.headers['x-shop-id'];
    const identity = await this.identity.resolve({
      authorization: request.headers.authorization,
      shopId: typeof shopHeader === 'string' ? shopHeader : undefined,
    });
    request.log = request.log.child({ userId: identity.user.id, shopId: identity.shop.id });
    request.actor = {
      ...identity,
      requestId: request.requestId,
      traceId: request.traceId,
      ipAddress: request.ip,
      log: request.log,
    };
    return true;
  }
}

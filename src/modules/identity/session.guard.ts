import {
  Inject,
  Injectable,
  createParamDecorator,
  type ExecutionContext,
  type CanActivate,
} from '@nestjs/common';
import type { HttpRequest } from '../../http/request-context.js';
import { IdentityService } from './identity.service.js';
import type { ActorContext } from './contracts.js';
import { unauthorized } from '../../lib/errors.js';
export type SessionActor = Omit<ActorContext, 'shop' | 'role'>;
interface SessionRequest extends HttpRequest {
  sessionActor?: SessionActor;
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const user = await this.identity.authenticate(
      request.headers.authorization,
    );
    request.log = request.log.child({ userId: user.id });
    request.sessionActor = {
      user,
      requestId: request.requestId,
      traceId: request.traceId,
      ipAddress: request.ip,
      log: request.log,
    };
    return true;
  }
}
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionActor => {
    const actor = context
      .switchToHttp()
      .getRequest<SessionRequest>().sessionActor;
    if (!actor) throw unauthorized();
    return actor;
  },
);

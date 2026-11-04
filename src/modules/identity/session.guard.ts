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
import { assertExpectedUser } from './expected-user.js';
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
    const identity = await this.identity.authenticate(
      request.headers.cookie,
    );
    assertExpectedUser(request.headers['x-client-user-id'], identity.user.id);
    request.log = request.log.child({ userId: identity.user.id });
    request.sessionActor = {
      ...identity,
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

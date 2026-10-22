import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { unauthorized } from '../../lib/errors.js';
import type { ActorContext } from './contracts.js';
import type { ActorRequest } from './actor-request.js';

export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext): ActorContext => {
  const actor = context.switchToHttp().getRequest<ActorRequest>().actor;
  if (!actor) throw unauthorized();
  return actor;
});

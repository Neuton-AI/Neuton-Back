import type { HttpRequest } from '../../http/request-context.js';
import type { ActorContext } from './contracts.js';

export interface ActorRequest extends HttpRequest {
  actor?: ActorContext;
}

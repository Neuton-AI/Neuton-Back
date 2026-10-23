import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { Type } from '@nestjs/common';
import {
  configureHttpApplication,
  type HttpOptions,
} from '../../src/http/application.js';
export interface InjectInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}
/** HTTP-only convenience adapter: every request traverses the actual Nest/Express stack. */
export function httpClient(
  app: NestExpressApplication,
  defaults: Record<string, string> = {},
) {
  return {
    async inject(input: InjectInput) {
      const method = input.method.toLowerCase() as
        'get' | 'post' | 'patch' | 'delete' | 'put' | 'options';
      let call = request(app.getHttpServer())
        [method](input.url)
        .set({ ...defaults, ...input.headers });
      if (input.payload !== undefined) call = call.set('content-type','application/json').send(JSON.stringify(input.payload));
      const result = await call;
      return {
        statusCode: result.status,
        headers: result.headers,
        body: result.text,
        json: () => result.body,
      };
    },
    close: () => app.close(),
  };
}
export async function testApplication(
  root: Type,
  overrides: Array<[unknown, unknown]>,
  options?: Partial<HttpOptions>,
) {
  let builder = Test.createTestingModule({ imports: [root] });
  for (const [token, value] of overrides)
    builder = builder.overrideProvider(token).useValue(value);
  const module = await builder.compile();
  const app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  return configureHttpApplication(app, {
    origins: [],
    bodyLimit: 1000000,
    rateLimit: { max: 10000, windowMs: 60000 },
    ...options,
  });
}

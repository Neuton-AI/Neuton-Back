import './support/testEnv.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller, Get, Module, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createHttpApplication } from '../src/http/application.js';
import { conflict } from '../src/lib/errors.js';
import { LoggerImpl } from '../src/lib/logger/index.js';

@Controller()
class ProbeController {
  @Get('/health') health() { return { ok: true, service: 'neuton-api' }; }
  @Get('/validation') validation() { return z.string().parse(42); }
  @Get('/conflict') conflict() { throw conflict('Already applied'); }
  @Get('/failure') failure() { throw new Error('private database password'); }
  @Get('/database') database() { throw Object.assign(new Error('private connection'), { code: 'ECONNRESET' }); }
  @Post('/raw') raw(@Req() req: RawBodyRequest<Request>) {
    return { raw: req.rawBody?.toString('utf8'), parsed: req.body };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

test('Nest HTTP foundation preserves errors, correlation, security and raw webhook bytes', async () => {
  const events: Record<string, unknown>[] = [];
  const app = await createHttpApplication(ProbeModule, {
    origins: ['https://neuton.test'], bodyLimit: 128, rateLimit: { max: 100, windowMs: 60_000 },
    observe: (event) => events.push(event),
  });
  try {
    const server = app.getHttpServer();
    const health = await request(server).get('/health').set('x-trace-id', 'test-trace');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, service: 'neuton-api' });
    assert.equal(health.headers['x-trace-id'], 'test-trace');
    assert.match(health.headers['content-security-policy'] ?? '', /default-src 'none'/);
    for (const [path, status, code] of [
      ['/validation', 400, 'VALIDATION_ERROR'], ['/conflict', 409, 'CONFLICT'],
      ['/failure', 500, 'INTERNAL_ERROR'], ['/missing', 404, 'NOT_FOUND'],
    ] as const) {
      const response = await request(server).get(path).set('x-trace-id', 'error-trace');
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, code);
      assert.equal(response.body.error.traceId, 'error-trace');
      assert.ok(!JSON.stringify(response.body).includes('password'));
    }
    const raw = '{ "amount": 12.50 }';
    const webhook = await request(server).post('/raw').set('Content-Type', 'application/json').send(raw);
    assert.equal(webhook.status, 201);
    assert.deepEqual(webhook.body, { raw, parsed: { amount: 12.5 } });
    const malformed = await request(server).post('/raw').set('Content-Type', 'application/json').send('{invalid');
    assert.equal(malformed.status, 400);
    assert.ok(malformed.body.error.traceId);
    const large = await request(server).post('/raw').send({ value: 'x'.repeat(256) });
    assert.equal(large.status, 413);
    const cors = await request(server).options('/health').set('Origin', 'https://neuton.test').set('Access-Control-Request-Method', 'GET');
    assert.equal(cors.headers['access-control-allow-origin'], 'https://neuton.test');
    assert.match(cors.headers['access-control-expose-headers'] ?? '', /X-Trace-Id/i);
    assert.ok(events.some(e => e.event === 'http_request_completed' && e.traceId === 'error-trace' && e.statusCode === 500));
    assert.ok(events.every(e => typeof e.durationMs === 'number' && e.entryPoint === 'http'));
  } finally { await app.close(); }
});

test('Nest HTTP rate limiting uses the public error envelope', async () => {
  const app = await createHttpApplication(ProbeModule, {
    origins: [], bodyLimit: 128, rateLimit: { max: 1, windowMs: 60_000 },
  });
  try {
    await request(app.getHttpServer()).get('/health').expect(200);
    const limited = await request(app.getHttpServer()).get('/health');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(limited.body.error.traceId);
    assert.ok(limited.headers['retry-after']);
  } finally { await app.close(); }
});

test('trusted proxies preserve independent client rate limits and failures retain safe diagnostics', async () => {
  const lines: Record<string, unknown>[] = [];
  const logger = new LoggerImpl({ write: (_level, _message, meta) => { lines.push(meta); } }, {}, 'debug');
  const app = await createHttpApplication(ProbeModule, {
    origins: [], bodyLimit: 128, rateLimit: { max: 1, windowMs: 60_000 },
    trustProxy: ['loopback'], logger,
  });
  try {
    const server = app.getHttpServer();
    await request(server).get('/health').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await request(server).get('/health').set('X-Forwarded-For', '192.0.2.2').expect(200);
    await request(server).get('/health').set('X-Forwarded-For', '192.0.2.1').expect(429);
    await request(server).get('/failure').set('X-Forwarded-For', '192.0.2.3').set('X-Trace-Id', 'diagnostic').expect(500);
    const failure = lines.find(line => line.event === 'http_request_failed');
    assert.equal(failure?.traceId, 'diagnostic');
    assert.equal(failure?.errorType, 'Error');
    assert.match(String(failure?.stackFrames), /ProbeController.failure/);
    assert.ok(!JSON.stringify(lines).includes('private database password'));
    const database = await request(server).get('/database').set('X-Forwarded-For', '192.0.2.4');
    assert.equal(database.status, 503);
    assert.ok(database.headers['retry-after']);
  } finally { await app.close(); }
});

test('unsupported body encoding is a client error and denied origins remain generic', async () => {
  const app = await createHttpApplication(ProbeModule, {
    origins: [], bodyLimit: 128, rateLimit: { max: 100, windowMs: 60_000 },
  });
  try {
    const encoding = await request(app.getHttpServer()).post('/raw')
      .set('Content-Type', 'application/json; charset=unsupported').send('{}');
    assert.equal(encoding.status, 415);
    assert.equal(encoding.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    const denied = await request(app.getHttpServer()).get('/health').set('Origin', 'https://untrusted.test');
    assert.equal(denied.status, 500);
    assert.equal(denied.body.error.message, 'Something went wrong');
    assert.ok(!denied.headers['access-control-allow-origin']);
    const trace = await request(app.getHttpServer()).get('/health').set('X-Trace-Id', 'invalid trace');
    assert.match(trace.headers['x-trace-id'] ?? '', /^[0-9a-f-]{36}$/);
  } finally { await app.close(); }
});

import './support/testEnv.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoggerFactory, FastifyLoggerAdapter, LoggerImpl } from '../src/lib/logger/index.js';
import type { LogLevel } from '../src/lib/logger/types.js';
import type { Transport } from '../src/lib/logger/transports/index.js';

interface Line {
  level: LogLevel;
  message: string | undefined;
  meta: Record<string, unknown>;
}

function capture(): { transport: Transport; lines: Line[] } {
  const lines: Line[] = [];
  const transport: Transport = {
    write(level, message, meta) {
      lines.push({ level, message, meta });
    },
  };
  return { transport, lines };
}

test('message-first and meta-first call shapes produce the same line', () => {
  const { transport, lines } = capture();
  const log = new LoggerImpl(transport, {}, 'debug');

  log.info('hello', { a: 1 });
  log.info({ a: 1 }, 'hello');

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { level: 'info', message: 'hello', meta: { a: 1 } });
  assert.deepEqual(lines[1], lines[0]);
});

test('an Error first argument lands under err and its message becomes the line message', () => {
  const { transport, lines } = capture();
  const log = new LoggerImpl(transport, {}, 'debug');
  const err = new Error('boom');

  log.error(err, { traceId: 't1' });
  assert.equal(lines[0]?.message, 'boom');
  assert.equal(lines[0]?.meta.err, err);
  assert.equal(lines[0]?.meta.traceId, 't1');

  log.error({ err }, 'custom message');
  assert.equal(lines[1]?.message, 'custom message');
  assert.equal(lines[1]?.meta.err, err);
});

test('child context merges over the parent and call meta wins over both', () => {
  const { transport, lines } = capture();
  const log = new LoggerImpl(transport, { service: 'api' }, 'debug');
  const child = log.child({ traceId: 't1', service: 'overridden' });

  child.warn('m', { traceId: 'from-call' });

  assert.deepEqual(lines[0]?.meta, { service: 'overridden', traceId: 'from-call' });
});

test('dynamic context is re-evaluated on every write', () => {
  const { transport, lines } = capture();
  let userId: string | undefined;
  const log = new LoggerImpl(transport, { base: true }, 'debug').withDynamic(() => ({ userId }));

  log.info('before auth');
  assert.equal(lines[0]?.meta.base, true);
  assert.equal(lines[0]?.meta.userId, undefined);

  userId = 'user-1';
  log.info('after auth');
  assert.equal(lines[1]?.meta.userId, 'user-1');
});

test('levels filter below the threshold; null silences; setLevel reopens', () => {
  const { transport, lines } = capture();
  const log = new LoggerImpl(transport, {}, 'info');

  log.debug('dropped');
  log.info('kept');
  assert.deepEqual(lines.map((l) => l.level), ['info']);

  log.level = null;
  log.error('dropped by silence');
  assert.equal(lines.length, 1);

  log.level = 'debug';
  log.debug('kept after reopening');
  assert.equal(lines.length, 2);
});

test('the Fastify adapter satisfies the logger contract and maps levels', () => {
  const { transport, lines } = capture();
  const adapter = new FastifyLoggerAdapter(new LoggerImpl(transport, {}, 'debug'));

  adapter.info('m', { a: 1 });
  assert.deepEqual(lines[0], { level: 'info', message: 'm', meta: { a: 1 } });

  assert.equal(adapter.level, 'debug');
  adapter.level = 'trace';
  assert.equal(adapter.level, 'debug');

  adapter.level = 'silent';
  adapter.error('dropped');
  assert.equal(lines.length, 1);
  assert.equal(adapter.level, 'silent');

  adapter.level = 'debug';
  adapter.trace('absorbed as debug');
  assert.equal(lines[1]?.level, 'debug');
  adapter.silent();
  assert.equal(lines.length, 2);
});

test('adapter children inherit bindings into every line', () => {
  const { transport, lines } = capture();
  const adapter = new FastifyLoggerAdapter(new LoggerImpl(transport, {}, 'debug'));

  adapter.child({ reqId: 'req-1' }).info('m');

  assert.equal(lines[0]?.meta.reqId, 'req-1');
});

test('the factory caches roots per service and shuts down idempotently', async () => {
  const factory = createLoggerFactory();

  assert.equal(factory.create('api'), factory.create('api'));
  assert.notEqual(factory.create('api'), factory.create('worker'));

  await factory.shutdown();
  await factory.shutdown();
});

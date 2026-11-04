import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { createDatabaseConnection } from '../src/db/connection.js';

test('required TLS refuses an insecure endpoint before sending credentials or SQL', async () => {
  const received: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => { received.push(bytes); socket.end('N'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = createDatabaseConnection('app', { DATABASE_URL:
    `postgresql://neuton_app:synthetic-private-password@127.0.0.1:${address.port}/local_test?sslmode=require&channel_binding=require` });
  try {
    await assert.rejects(client`select 'must not be sent'`);
    assert.equal(Buffer.concat(received).length, 8);
    assert.equal(received[0]!.readInt32BE(4), 80877103);
    assert.equal(Buffer.concat(received).includes(Buffer.from('synthetic-private-password')), false);
  } finally {
    await client.end({ timeout: 1 });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

/** A local protocol bridge exercises the actual installed driver and Drizzle against PostgreSQL WASM. */
test('v4 and Drizzle preserve decimal/date mappings, parameters and transaction/savepoint rollback', async () => {
  const database = new PGlite();
  await database.waitReady;
  const sockets = new Set<Socket>();
  const frame = (type: string, payload: Buffer) => {
    const header = Buffer.alloc(5); header.write(type); header.writeInt32BE(payload.length + 4, 1);
    return Buffer.concat([header, payload]);
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let startup = true;
    let buffered = Buffer.alloc(0);
    let work = Promise.resolve();
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5) {
        const length = startup ? buffered.readInt32BE(0) : buffered.readInt32BE(1) + 1;
        if (buffered.length < length) return;
        const message = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        if (startup) {
          startup = false;
          socket.write(Buffer.concat([
            frame('R', Buffer.alloc(4)),
            frame('S', Buffer.from('server_version\0' + '17.0\0')),
            frame('S', Buffer.from('client_encoding\0UTF8\0')),
            frame('S', Buffer.from('TimeZone\0UTC\0')),
            frame('K', Buffer.alloc(8)), frame('Z', Buffer.from('I')),
          ]));
        } else if (message[0] !== 'X'.charCodeAt(0)) {
          work = work.then(async () => { socket.write(await database.execProtocolRaw(message)); })
            .catch(() => { socket.destroy(); });
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // Only this in-memory protocol fixture is plaintext; production factories require TLS and binding.
  const client = postgres(`postgresql://synthetic:synthetic@127.0.0.1:${address.port}/local`, {
    ssl: false, channel_binding: 'disable', infer: true, max: 1, prepare: false, fetch_types: false,
  });
  try {
    const orm = drizzle(client);
    await orm.execute(sql`create table driver_probe(id integer primary key, price numeric(10,2), day date)`);
    await orm.transaction(async tx => {
      await tx.execute(sql`insert into driver_probe values (${1}, ${'12.30'}, ${'2026-11-04'})`);
      await assert.rejects(tx.transaction(async nested => {
        await nested.execute(sql`update driver_probe set price=${'99.99'}`);
        throw new Error('Rollback savepoint');
      }), /Rollback savepoint/);
    });
    const rows = await orm.execute(sql`select price,day from driver_probe where id=${1}`);
    assert.deepEqual([...rows], [{ price: '12.30', day: '2026-11-04' }]);
    await assert.rejects(orm.transaction(async tx => {
      await tx.execute(sql`delete from driver_probe`);
      throw new Error('Rollback outer transaction');
    }), /Rollback outer transaction/);
    assert.equal((await orm.execute(sql`select * from driver_probe`)).length, 1);
  } finally {
    await client.end({ timeout: 1 });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await database.close();
  }
});

import { skipWithoutDisposableDatabase, testDatabaseUrl } from './support/testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import request from 'supertest';
import { waitForBlockedTransactions } from './support/postgresLocks.js';

const origin = 'https://app.example.test';
process.env.APP_ORIGIN = origin;
const outgoingPath = '/api/v1/shop/team/invitations';
const inboxPath = '/api/v1/shop-invitations';
const searchPath = '/api/v1/shop/team/accounts/search';

function cookieFrom(response: request.Response, name: string) {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `Expected ${name} cookie`);
  return cookie.split(';')[0]!;
}

async function invitationFixture(observe?: (event: Record<string, unknown>) => void) {
  const { AppModule } = await import('../src/app.js');
  const { testApplication } = await import('./support/httpClient.js');
  const app = await testApplication(AppModule, [], { origins: [origin], observe });
  await app.listen(0, '127.0.0.1');
  const api = request(app.getHttpServer());
  const getProof = (cookie = '') => api.post('/api/v1/auth/csrf').set({ Origin: origin, Cookie: cookie }).expect(200);
  async function account(name: string) {
    const email = `${randomUUID()}@example.test`;
    const context = await getProof();
    const created = await api.post('/api/v1/auth/signup').set({
      Origin: origin,
      Cookie: cookieFrom(context, '__Host-neuton-context'),
      'X-CSRF-Token': context.body.token as string,
    }).send({ email, password: 'testpass10', fullName: name }).expect(201);
    const Cookie = cookieFrom(created, '__Host-neuton-session');
    const proof = await getProof(Cookie);
    return {
      id: created.body.user.id as string,
      email,
      headers: { Origin: origin, Cookie, 'X-CSRF-Token': proof.body.token as string },
    };
  }
  async function shop(owner: Awaited<ReturnType<typeof account>>, name: string) {
    const result = await api.post('/api/v1/shops').set(owner.headers).send({ name }).expect(201);
    return result.body.shop.id as string;
  }
  return { app, api, account, shop };
}

test('the invitation migration preserves memberships and enforces the new storage rules', {
  skip: skipWithoutDisposableDatabase,
}, async () => {
  const connection = postgres(testDatabaseUrl!, { onnotice: () => {} });
  try {
    await connection.begin(async (tx) => {
      await tx`CREATE SCHEMA invitation_migration_rehearsal`;
      await tx`SET LOCAL search_path TO invitation_migration_rehearsal, public`;
      await tx`CREATE TABLE users (LIKE public.users INCLUDING ALL)`;
      await tx`CREATE TABLE shops (LIKE public.shops INCLUDING ALL)`;
      await tx`CREATE TABLE shop_members (LIKE public.shop_members INCLUDING ALL)`;

      const [shop] = await tx<{ id: string }[]>`
        INSERT INTO shops (name, slug) VALUES ('Prior Shop', 'prior-shop') RETURNING id
      `;
      const accounts = await tx<{ id: string }[]>`
        INSERT INTO users (email) VALUES ('owner@example.test'), ('admin@example.test'),
          ('member@example.test'), ('invitee@example.test'), ('other@example.test') RETURNING id
      `;
      const [owner, admin, member, invitee, other] = accounts;
      assert.ok(shop && owner && admin && member && invitee && other);
      await tx`INSERT INTO shop_members (shop_id, user_id, role) VALUES
        (${shop.id}, ${owner.id}, 'owner'), (${shop.id}, ${admin.id}, 'admin'),
        (${shop.id}, ${member.id}, 'member')`;
      const memberships = await tx`SELECT id, user_id, role FROM shop_members ORDER BY id`;

      const migration = await readFile(new URL('../drizzle/0044_shop_invitations.sql', import.meta.url), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) {
        await tx.unsafe(statement.trim());
      }
      assert.deepEqual(await tx`SELECT id, user_id, role FROM shop_members ORDER BY id`, memberships);

      const insertInvite = (sql: typeof tx, recipientId: string, role = 'member') => sql`
        INSERT INTO shop_invitations (shop_id, recipient_id, offered_role)
        VALUES (${shop.id}, ${recipientId}, ${role}) RETURNING status, read_at, resolved_at
      `;
      const [pending] = await insertInvite(tx, invitee.id);
      assert.deepEqual(pending, { status: 'pending', read_at: null, resolved_at: null });
      await assert.rejects(tx.savepoint((sql) => insertInvite(sql, invitee.id, 'admin')), { code: '23505' });
      await assert.rejects(tx.savepoint((sql) => insertInvite(sql, other.id, 'owner')), { code: '23514' });
      await tx`UPDATE shop_invitations SET status = 'declined', resolved_at = now() WHERE recipient_id = ${invitee.id}`;
      await insertInvite(tx, invitee.id, 'admin');
      await insertInvite(tx, other.id);

      await tx`DELETE FROM users WHERE id = ${invitee.id}`;
      const remaining = await tx<{ recipient_id: string }[]>`SELECT recipient_id FROM shop_invitations`;
      assert.deepEqual(remaining.map((row) => row.recipient_id), [other.id]);
      await tx`DELETE FROM shops WHERE id = ${shop.id}`;
      const afterShopDelete = await tx`SELECT id FROM shop_invitations`;
      assert.equal(afterShopDelete.length, 0);
      await tx`DROP SCHEMA invitation_migration_rehearsal CASCADE`;
    });
  } finally {
    await connection.end();
  }
});

test('shop owners can search literal name or email fragments with scoped eligibility and pagination', {
  skip: skipWithoutDisposableDatabase,
  timeout: 30000,
}, async () => {
  const events: Record<string, unknown>[] = [];
  const { app, api, account, shop } = await invitationFixture((event) => events.push(event));
  const connection = postgres(testDatabaseUrl!);
  try {
    const owner = await account('Search Owner');
    const admin = await account('Search Admin');
    const outsider = await account('Other Search Owner');
    const shopId = await shop(owner, 'Search Shop');
    const otherShopId = await shop(outsider, 'Other Search Shop');
    const prefix = `kin${randomUUID().slice(0, 8)}`;
    const names = [`Dana ${prefix}`, `Dana ${prefix}`, null, `Noah ${prefix}`, `Another ${prefix}`];
    const rows = await Promise.all(names.map(async (fullName, index) => {
      const [row] = await connection<{ id: string; email: string }[]>`
        INSERT INTO users (email, full_name) VALUES (${`${prefix}-${index}@example.test`}, ${fullName}) RETURNING id, email
      `;
      assert.ok(row);
      return row;
    }));
    const [knownMember, pending] = rows;
    assert.ok(knownMember && pending);
    await connection`INSERT INTO shop_members (shop_id, user_id, role) VALUES
      (${shopId}, ${knownMember.id}, 'member'), (${shopId}, ${admin.id}, 'admin')`;
    await connection`INSERT INTO shop_invitations (shop_id, recipient_id, offered_role) VALUES
      (${shopId}, ${pending.id}, 'member')`;
    const search = (actor: typeof owner, query: string, page = 1, scope = shopId) =>
      api.post(searchPath).set({ ...actor.headers, 'X-Shop-Id': scope }).send({ query, page });

    await search(admin, prefix).expect(403);
    await search(owner, prefix, 1, otherShopId).expect(403);
    await search(owner, '   ').expect(400);
    await search(owner, prefix, 0).expect(400);
    const first = await search(owner, ` ${prefix.toUpperCase()} `).expect('Cache-Control', 'no-store').expect(200);
    assert.deepEqual(first.body, {
      accounts: rows.slice(0, 4).map((row, index) => ({
        id: row.id, email: row.email, fullName: names[index], eligibility: ['member', 'pending', 'eligible', 'eligible'][index],
      })),
      page: 1,
      pageCount: 2,
    });
    const next = await search(owner, prefix, 2).expect(200);
    assert.deepEqual(next.body.accounts.map((row: { email: string }) => row.email), [rows[4]?.email]);
    const byName = await search(owner, `DANA ${prefix.toUpperCase()}`).expect(200);
    assert.deepEqual(byName.body.accounts.map((row: { id: string }) => row.id), [knownMember.id, pending.id]);
    const other = await search(outsider, prefix, 1, otherShopId).expect(200);
    assert.ok(other.body.accounts.every((row: { eligibility: string }) => row.eligibility === 'eligible'));
    for (const special of ['%', '_', '\\']) {
      const literal = await search(owner, `${prefix}${special}`).expect(200);
      assert.deepEqual(literal.body.accounts, []);
    }
    assert.ok(events.some((event) => event.route === searchPath && event.statusCode === 200));
    assert.ok(!JSON.stringify(events).includes(prefix));
    assert.ok(!JSON.stringify(events).includes(prefix.toUpperCase()));
  } finally {
    await app.close();
    await connection.end();
  }
});

test('owner can send and list pending invites only in the selected shop', {
  skip: skipWithoutDisposableDatabase,
  timeout: 30000,
}, async () => {
  const { app, api, account, shop } = await invitationFixture();
  const connection = postgres(testDatabaseUrl!);
  try {
    const owner = await account('Shop Owner');
    const admin = await account('Existing Admin');
    const member = await account('Existing Member');
    const recipient = await account('Invite Recipient');
    const foreignOwner = await account('Foreign Owner');
    const shopId = await shop(owner, 'Inviting Shop');
    const otherShopId = await shop(foreignOwner, 'Other Inviting Shop');
    await connection`INSERT INTO shop_members (shop_id, user_id, role) VALUES
      (${shopId}, ${admin.id}, 'admin'), (${shopId}, ${member.id}, 'member')`;

    const send = (actor: typeof owner, recipientId: string, offeredRole: string, scope = shopId) =>
      api.post(outgoingPath).set({ ...actor.headers, 'X-Shop-Id': scope }).send({ recipientId, offeredRole });
    const list = (actor: typeof owner, scope = shopId) =>
      api.get(outgoingPath).set({ ...actor.headers, 'X-Shop-Id': scope });

    await api.get(outgoingPath).set('X-Shop-Id', shopId).expect(401);
    await api.post(outgoingPath).set({ Origin: origin, Cookie: owner.headers.Cookie, 'X-Shop-Id': shopId })
      .send({ recipientId: recipient.id, offeredRole: 'admin' }).expect(403);
    for (const nonOwner of [admin, member, foreignOwner]) {
      await send(nonOwner, recipient.id, 'member').expect(403);
      await list(nonOwner).expect(403);
    }
    await list(owner, otherShopId).expect(403);
    await send(owner, recipient.id, 'admin', otherShopId).expect(403);
    await send(owner, member.id, 'admin').expect(409);
    await send(owner, recipient.id, 'owner').expect(400);
    await send(owner, randomUUID(), 'member').expect(404);

    const payload = { recipientId: recipient.id, offeredRole: 'admin' };
    const attempts = await Promise.all([send(owner, recipient.id, 'admin'), send(owner, recipient.id, 'admin')]);
    assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
    const created = attempts.find((response) => response.status === 201);
    const roster = await list(owner).expect('Cache-Control', 'no-store').expect(200);
    const invite = roster.body.invitations[0];
    assert.equal(roster.body.invitations.length, 1);
    assert.deepEqual(invite, {
      id: created?.body.invitation.id,
      ...payload,
      fullName: 'Invite Recipient',
      email: recipient.email,
      createdAt: created?.body.invitation.createdAt,
    });
    await send(foreignOwner, recipient.id, 'member', otherShopId).expect(201);
    const otherList = await list(foreignOwner, otherShopId).expect(200);
    assert.deepEqual(otherList.body.invitations.map((row: { offeredRole: string }) => row.offeredRole), ['member']);
    assert.equal((await connection`SELECT id FROM shop_members WHERE user_id = ${recipient.id}`).length, 0);
  } finally {
    await app.close();
    await connection.end();
  }
});

test('invitations resolve once through the owner and zero-shop recipient routes', {
  skip: skipWithoutDisposableDatabase,
  timeout: 45000,
}, async () => {
  const { app, api, account, shop } = await invitationFixture();
  const connection = postgres(testDatabaseUrl!);
  try {
    const owner = await account('Inviting Owner');
    const recipient = await account('Zero Shop Recipient');
    const outsider = await account('Unrelated Owner');
    const shopId = await shop(owner, 'Invitation Race Shop');
    const otherShopId = await shop(outsider, 'Unrelated Shop');
    const ownerHeaders = { ...owner.headers, 'X-Shop-Id': shopId };
    const inbox = (actor: typeof owner) => api.get(inboxPath).set(actor.headers);
    const respond = (actor: typeof owner, id: string, response: 'accept' | 'decline') =>
      api.post(`${inboxPath}/${id}/${response}`).set(actor.headers);
    const cancel = (id: string, headers = ownerHeaders) => api.delete(`${outgoingPath}/${id}`).set(headers);
    const shopAccess = () => api.get('/api/v1/shop').set({ ...recipient.headers, 'X-Shop-Id': shopId });
    const send = async () => {
      const response = await api.post(outgoingPath).set(ownerHeaders)
        .send({ recipientId: recipient.id, offeredRole: 'admin' }).expect(201);
      return response.body.invitation.id as string;
    };
    const memberships = () => connection<{ role: string }[]>`
      SELECT role FROM shop_members WHERE shop_id = ${shopId} AND user_id = ${recipient.id}
    `;

    await api.get(inboxPath).expect(401);
    const session = await api.get('/api/v1/session').set(recipient.headers).expect(200);
    assert.deepEqual(session.body.memberships, []);
    const initialId = await send();
    await shopAccess().expect(403);
    const listing = await inbox(recipient).expect('Cache-Control', 'no-store').expect(200);
    assert.equal(listing.body.invitations.length, 1);
    assert.deepEqual(listing.body.invitations[0], {
      id: initialId,
      shopId,
      shopName: 'Invitation Race Shop',
      offeredRole: 'admin',
      createdAt: listing.body.invitations[0].createdAt,
      readAt: null,
    });
    assert.deepEqual((await inbox(outsider).expect(200)).body.invitations, []);
    await respond(outsider, initialId, 'accept').expect(404);
    await respond(outsider, initialId, 'decline').expect(404);
    await cancel(initialId, { ...outsider.headers, 'X-Shop-Id': otherShopId }).expect(404);
    await cancel(initialId, { ...outsider.headers, 'X-Shop-Id': shopId }).expect(403);
    await api.post(`${inboxPath}/${initialId}/accept`).set({ Origin: origin, Cookie: recipient.headers.Cookie }).expect(403);

    const accepted = await respond(recipient, initialId, 'accept').send({ offeredRole: 'owner' }).expect(200);
    assert.deepEqual(accepted.body.membership, { shopId, role: 'admin' });
    await shopAccess().expect(200);
    assert.deepEqual((await memberships()).map((row) => row.role), ['admin']);
    assert.deepEqual((await inbox(recipient).expect(200)).body.invitations, []);
    await connection`DELETE FROM shop_members WHERE shop_id = ${shopId} AND user_id = ${recipient.id}`;
    await respond(recipient, initialId, 'accept').expect(409);
    await shopAccess().expect(403);

    for (const competitor of ['decline', 'cancel'] as const) {
      for (const acceptFirst of [true, false]) {
        const id = await send();
        const accept = () => respond(recipient, id, 'accept');
        const close = () => competitor === 'cancel' ? cancel(id) : respond(recipient, id, 'decline');
        const first = acceptFirst ? accept : close;
        const second = acceptFirst ? close : accept;
        const queued = await connection.begin(async (tx) => {
          const [blocker] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM shops WHERE id = ${shopId} FOR UPDATE`;
          assert.ok(blocker);
          const winner = first().then((response) => response.status);
          await waitForBlockedTransactions(connection, blocker.pid, 1);
          const loser = second().then((response) => response.status);
          await waitForBlockedTransactions(connection, blocker.pid, 2);
          return { winner, loser };
        });
        assert.deepEqual(await Promise.all([queued.winner, queued.loser]), [acceptFirst ? 200 : 204, 409]);
        const [stored] = await connection<{ status: string }[]>`SELECT status FROM shop_invitations WHERE id = ${id}`;
        let expectedStatus = 'accepted';
        if (!acceptFirst) expectedStatus = competitor === 'cancel' ? 'canceled' : 'declined';
        assert.equal(stored?.status, expectedStatus);
        assert.deepEqual((await memberships()).map((row) => row.role), acceptFirst ? ['admin'] : []);
        assert.deepEqual((await inbox(recipient).expect(200)).body.invitations, []);
        await connection`DELETE FROM shop_members WHERE shop_id = ${shopId} AND user_id = ${recipient.id}`;
      }
    }
  } finally {
    await app.close();
    await connection.end();
  }
});

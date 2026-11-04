import './testEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDatabaseConnection } from '../../src/db/connection.js';
import * as schema from '../../src/db/schema/index.js';
import { withShopTransaction } from '../../src/db/tenant-context.js';
import type { ShopTransaction } from '../../src/db/types.js';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import { SessionRepository } from '../../src/modules/auth/session.repository.js';
import { ShopsPersistence } from '../../src/modules/shops/shops.persistence.js';
import { createShopSchema } from '../../src/modules/shops/contracts.js';
import type { ActorContext } from '../../src/modules/identity/contracts.js';
import { apiLogger } from '../../src/lib/logger/index.js';
import { isPlaceholder } from './testEnv.js';

// The development database is also the integration-test database. Seeding and
// cleanup use its owner connection; application work keeps the restricted role.
export const neonTestSkip = (isPlaceholder('DATABASE_URL') ||
  !process.env.AUTH_DATABASE_URL || !process.env.MIGRATION_DATABASE_URL) &&
  'requires the development DATABASE_URL, AUTH_DATABASE_URL and MIGRATION_DATABASE_URL';

export async function neonFixture() {
  const target = (value: string | undefined) => {
    assert.ok(value, 'Development database setting required');
    const url = new URL(value);
    return `${url.hostname.replace('-pooler.', '.')}:${url.port || '5432'}${url.pathname}`;
  };
  assert.equal(target(process.env.DATABASE_URL), target(process.env.MIGRATION_DATABASE_URL),
    'Fixture owner and app connections must target the same development database');
  assert.equal(target(process.env.DATABASE_URL), target(process.env.AUTH_DATABASE_URL),
    'Fixture auth and app connections must target the same development database');
  const ownerConnection = createDatabaseConnection('migration');
  const appConnection = createDatabaseConnection('app');
  const authConnection = createDatabaseConnection('auth');
  const admin = drizzle(ownerConnection, { schema });
  const application = drizzle(appConnection, { schema });
  const auth = new AuthRepository(drizzle(authConnection, { schema }));
  const userId = randomUUID();
  let shopId: string | undefined;
  let userCreated = false;
  async function close() {
    try {
      await ownerConnection.begin(async tx => {
        if (shopId) {
          await tx`delete from public.shops where id=${shopId}`;
          // Cleanup intents deliberately survive shop deletion. These fixtures
          // never upload real objects, so remove only their own intents.
          await tx`delete from public.storage_object_deletions where shop_id=${shopId}`;
        }
        if (userCreated) {
          await tx`delete from auth_private.security_events where actor_user_id=${userId} or subject_user_id=${userId}`;
          await tx`delete from public.profiles where id=${userId}`;
          await tx`delete from auth_private.users where id=${userId}`;
        }
      });
    } finally {
      await Promise.all([ownerConnection.end({ timeout: 5 }), appConnection.end({ timeout: 5 }),
        authConnection.end({ timeout: 5 })]);
    }
  }
  try {
    // UUIDs are fresh for every test; never delete/reuse a pre-existing fixture.
    await ownerConnection.begin(async tx => {
      await tx`insert into auth_private.users(id,email,normalized_email,status,email_confirmed_at)
        values(${userId},${`integration-${userId}@example.test`},${`integration-${userId}@example.test`},'active',now())`;
      await tx`insert into public.profiles(id) values(${userId})`;
    });
    userCreated = true;
    const sessions = new SessionRepository(auth);
    const issued = await auth.withUser(userId, account => sessions.issue(account, { method: 'password' }, {}));
    assert.ok(issued);
    const session = await sessions.resolve(issued.secret);
    assert.ok(session);
    const sessionActor = {
      session: session.reference, sessionId: session.id,
      user: { id: userId, email: session.email, fullName: null, avatarUrl: null },
      log: apiLogger, traceId: 'neon-integration', requestId: randomUUID(),
    };
    const shop = await new ShopsPersistence(application).create(sessionActor,
      createShopSchema.parse({ name: `Integration ${userId}` }));
    shopId = shop.id;
    const actor: ActorContext = { ...sessionActor, shop, role: 'owner' };
    return { admin, application, ownerConnection, auth, sessions, actor, shop, userId, shopId,
      sessionId: session.id, secret: issued.secret,
      inShop<T>(work: (scope: ShopTransaction) => Promise<T>) {
        return withShopTransaction(application, session.reference, shop.id, work);
      }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

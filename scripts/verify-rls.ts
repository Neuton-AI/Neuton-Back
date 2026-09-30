import { sql } from '../src/db/client.js';

/**
 * Verifies tenant isolation by impersonating each user through the JWT GUC
 * that auth.uid() reads, running as the non-owner `authenticated` role so RLS
 * genuinely applies (table owners bypass it).
 *
 * Fixture data is created and removed inside a single transaction that is
 * rolled back, so nothing is left behind.
 */

await sql.begin(async (tx) => {
  // Fail loudly if RLS is not actually enabled on the tables under test.
  const rls = await tx<{ relname: string; enabled: boolean }[]>`
    select relname, relrowsecurity as enabled
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relname in ('shops','profiles','shop_members','inventory_items','recipes',
                      'categories','receipts','receipt_items','orders','order_items',
                      'recipe_ingredients','audit_logs')
      and not relrowsecurity
  `;
  if (rls.length > 0) {
    throw new Error(`RLS not enabled on: ${rls.map((r) => r.relname).join(', ')}`);
  }

  const policyCount = await tx<{ count: number }[]>`
    select count(*)::int as count from pg_policies
    where schemaname = 'public'
  `;
  console.log(`RLS enabled on 12 tables, ${policyCount[0]?.count} policies present`);

  const ownerId = '11111111-1111-1111-1111-111111111111';
  const memberId = '22222222-2222-2222-2222-222222222222';
  const outsiderId = '33333333-3333-3333-3333-333333333333';
  const shopA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const shopB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  await tx`
    insert into public.shops (id, name, slug) values
      (${shopA}, 'Shop A', 'shop-a'),
      (${shopB}, 'Shop B', 'shop-b')
  `;

  // profiles.id is FK'd to auth.users(id), so the fixture needs real auth rows.
  // They are created inside this transaction and vanish with the rollback.
  for (const userId of [ownerId, memberId, outsiderId]) {
    await tx`
      insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
      values (
        ${userId},
        ${`${userId.slice(0, 8)}@rls-test.local`},
        'authenticated',
        'authenticated',
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{}'::jsonb
      )
      on conflict (id) do nothing
    `;
    await tx`insert into public.profiles (id) values (${userId}) on conflict (id) do nothing`;
  }

  await tx`
    insert into public.shop_members (shop_id, user_id, role) values
      (${shopA}, ${ownerId}, 'owner'),
      (${shopA}, ${memberId}, 'member'),
      (${shopB}, ${ownerId}, 'admin')
  `;
  await tx`
    insert into public.inventory_items (shop_id, name, unit) values
      (${shopA}, 'Flour A', 'kg'),
      (${shopB}, 'Flour B', 'kg')
  `;

  /**
   * Fixture data must be written as the owner, then all assertions run under
   * SET LOCAL ROLE authenticated -- the table owner bypasses RLS, so testing as
   * the owner would report a false pass.
   *
   * Each call runs in a savepoint: a rejected statement aborts its enclosing
   * transaction, which would otherwise poison every later assertion.
   */
  async function asUser<T>(userId: string, statement: (t: typeof tx) => Promise<T>): Promise<T> {
    return tx.savepoint(async (sp) => {
      await sp`reset role`;
      await sp`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      await sp`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`;
      await sp`set local role authenticated`;
      return statement(sp as unknown as typeof tx);
    });
  }

  const failures: string[] = [];
  function check(label: string, actual: number, expected: number) {
    const ok = actual === expected;
    if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} (expected ${expected}, got ${actual})`);
  }

  console.log('\nshop_members scoped by membership:');
  check(
    'owner of shop A sees own 2 + co-members of shop A = 3',
    (await asUser(ownerId, (t) => tx<{ n: number }[]>`select count(*)::int n from public.shop_members`))[0]!.n,
    3,
  );
  check(
    'member of shop A only',
    (await asUser(memberId, (t) => tx<{ n: number }[]>`select count(*)::int n from public.shop_members`))[0]!.n,
    1,
  );
  check(
    'non-member sees nothing',
    (await asUser(outsiderId, (t) => tx<{ n: number }[]>`select count(*)::int n from public.shop_members`))[0]!.n,
    0,
  );

  console.log('\ninventory_items cross-tenant read:');
  check(
    'member of shop A cannot see shop B stock',
    (await asUser(memberId, (t) => tx<{ n: number }[]>`select count(*)::int n from public.inventory_items`))[0]!.n,
    1,
  );
  check(
    'non-member sees no inventory',
    (await asUser(outsiderId, (t) => tx<{ n: number }[]>`select count(*)::int n from public.inventory_items`))[0]!.n,
    0,
  );

  console.log('\ncross-tenant write:');
  // A WITH CHECK violation raises rather than filtering, so the pass condition
  // is that Postgres rejects the row.
  let writeBlocked = false;
  let writeError = '';
  try {
    await asUser(memberId, (t) => tx`
      insert into public.inventory_items (shop_id, name, unit)
      values (${shopB}, 'Injected', 'kg')
    `);
  } catch (error) {
    writeBlocked = true;
    writeError = error instanceof Error ? error.message : String(error);
  }
  check('member cannot insert into another shop', writeBlocked ? 1 : 0, 1);
  if (writeBlocked) console.log(`        rejected with: ${writeError.split('\n')[0]}`);

  // ...but the member must still be able to write into their own shop.
  await tx`reset role`;
  let ownWriteOk = false;
  try {
    await asUser(memberId, (t) => tx`
      insert into public.inventory_items (shop_id, name, unit)
      values (${shopA}, 'Own Shop Item', 'kg')
    `);
    ownWriteOk = true;
  } catch (error) {
    console.log(`        own-shop write failed: ${error instanceof Error ? error.message : error}`);
  }
  check('member can still write into their own shop', ownWriteOk ? 1 : 0, 1);

  console.log('\nhelper functions:');
  const helper = await asUser(memberId, (t) => tx<{ isMember: boolean; role: string | null }[]>`
    select public.is_shop_member(${shopA}) as "isMember", public.shop_role(${shopA}) as role
  `);
  check('is_shop_member true for own shop', helper[0]!.isMember ? 1 : 0, 1);
  check('shop_role resolves', helper[0]!.role === 'member' ? 1 : 0, 1);

  if (failures.length > 0) {
    throw new Error(`\n${failures.length} RLS assertion(s) failed:\n  ${failures.join('\n  ')}`);
  }

  console.log('\nAll RLS assertions passed.');
  throw new Error('__rollback__');
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '__rollback__') {
    console.log('\n(fixture rolled back — no rows persisted)');
  } else {
    console.error(`\nRLS VERIFICATION FAILED:\n${message}`);
    process.exitCode = 1;
  }
});

await sql.end({ timeout: 5 });

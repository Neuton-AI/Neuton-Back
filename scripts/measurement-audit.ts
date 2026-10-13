import { sql } from '../src/db/client.js';
// Read-only rollout report. No automatic reinterpretation of mixed balances.
try {
  const [schema] = await sql`select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'measurement_status') as migrated`;
  const inventory = schema?.migrated
    ? await sql`select id, shop_id, name, unit, current_quantity, average_unit_cost, measurement_status from inventory_items where measurement_status <> 'ready'`
    : await sql`select id, shop_id, name, unit, current_quantity, average_unit_cost, 'legacy_basis_unproven' as measurement_status from inventory_items`;
  const pending = schema?.migrated ? await sql`select shop_id, measurement_reason, count(*) from receipt_items where application_status = 'pending' and review_status = 'accepted' group by shop_id, measurement_reason` : [];
  const offers = schema?.migrated ? await sql`select measurement_status, count(*) from general_prices group by measurement_status` : [];
  console.log(JSON.stringify({ phase: schema?.migrated ? 'after-migration' : 'preflight', safelyNormalized: 'New ready balances only; historical balances require confirmed reconciliation. Purchase receipts alone do not prove remaining stock or consumption.', inventory, pending, offers }, null, 2));
} finally { await sql.end(); }

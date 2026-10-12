import { sql } from '../src/db/client.js';
// Read-only rollout report. No automatic reinterpretation of mixed balances.
try {
  const inventory = await sql`select id, shop_id, name, unit, current_quantity, average_unit_cost, measurement_status from inventory_items where measurement_status <> 'ready'`;
  const pending = await sql`select shop_id, measurement_reason, count(*) from receipt_items where application_status = 'pending' and review_status = 'accepted' group by shop_id, measurement_reason`;
  const offers = await sql`select measurement_status, count(*) from general_prices group by measurement_status`;
  console.log(JSON.stringify({ safelyNormalized: 'New ready balances only; historical balances require confirmed reconciliation', inventory, pending, offers }, null, 2));
} finally { await sql.end(); }

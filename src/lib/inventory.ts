/**
 * Inventory writes shared by the vision worker and the receipt verification
 * endpoint.
 *
 * These live outside `worker.ts` so `POST /receipts/:id/verify` can apply an
 * approved receipt through the exact code the worker uses. Every function takes
 * the handle it writes through instead of reaching for a module-level client:
 * the worker passes its transaction handle, so its inventory writes land inside
 * the receipt transaction rather than escaping it.
 */
import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { inventoryItems } from '../db/schema/index.js';
import { INVENTORY_UNITS, type InventoryUnit } from '../db/schema/enums.js';
import { quantity as qty, toNumber, unitCost } from './money.js';
import { applyWeightedAverage, type InventoryCostUpdate } from './pricing.js';

/** The quantity and average cost one weighted-average step is computed from. */
export interface InventorySnapshot {
  currentQuantity: string;
  averageUnitCost: string;
}

/**
 * A Drizzle client or a transaction handle. Both build the same queries and the
 * helpers below chain a handful of builder methods, so the handle itself is
 * typed loosely and every call site that passes one stays type-checked.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InventoryDb = any;

export async function findOrCreateInventoryItem(
  db: InventoryDb,
  shopId: string,
  rawName: string,
  unit: string | null,
): Promise<string | null> {
  const name = rawName.trim();
  if (name.length === 0) return null;

  const exact = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), eq(inventoryItems.name, name)))
    .limit(1);
  if (exact[0]) return exact[0].id;

  const fuzzy = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId), ilike(inventoryItems.name, `%${name}%`)))
    .limit(1);
  if (fuzzy[0]) return fuzzy[0].id;

  const created = await db
    .insert(inventoryItems)
    .values({
      shopId,
      name,
      unit: (INVENTORY_UNITS as readonly string[]).includes(unit ?? '')
        ? (unit as InventoryUnit)
        : 'unit',
      currentQuantity: '0.000',
    })
    .returning({ id: inventoryItems.id });

  return created[0]?.id ?? null;
}

/**
 * Reads one inventory row under a row lock.
 *
 * A transaction on its own does not stop two purchases of the same SKU from both
 * reading the same starting quantity, computing from it, and letting the second
 * write discard the first's contribution — a lost update that raises no error.
 * `POST /inventory/adjust` is immune because it does its arithmetic inside a
 * single statement, but the weighted-average formula needs the old quantity
 * *and* the old average together, so it cannot be collapsed that way.
 *
 * Returns `undefined` when the row is gone, which callers treat as a no-op.
 */
export async function lockInventoryRow(
  db: InventoryDb,
  inventoryItemId: string,
): Promise<InventorySnapshot | undefined> {
  const rows = await db
    .select({
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, inventoryItemId))
    .limit(1)
    .for('update');

  const row = rows[0];
  return row
    ? { currentQuantity: row.currentQuantity, averageUnitCost: row.averageUnitCost }
    : undefined;
}

/**
 * Locks several inventory rows at once, keyed by id, for a receipt that touches
 * more than one SKU.
 *
 * The ascending `id` order is load-bearing, not cosmetic: every caller must
 * take its locks in the same order, or two receipts listing the same SKUs in
 * opposite order deadlock each other.
 */
export async function lockInventoryRows(
  db: InventoryDb,
  inventoryItemIds: string[],
): Promise<Map<string, InventorySnapshot>> {
  const locked = new Map<string, InventorySnapshot>();
  if (inventoryItemIds.length === 0) return locked;

  const ordered = [...new Set(inventoryItemIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const rows = await db
    .select({
      id: inventoryItems.id,
      currentQuantity: inventoryItems.currentQuantity,
      averageUnitCost: inventoryItems.averageUnitCost,
    })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, ordered))
    .orderBy(asc(inventoryItems.id))
    .for('update');

  for (const row of rows) {
    locked.set(row.id, {
      currentQuantity: row.currentQuantity,
      averageUnitCost: row.averageUnitCost,
    });
  }

  return locked;
}

/** Writes a computed inventory state, stamping `updated_at`. */
export async function writeInventoryState(
  db: InventoryDb,
  inventoryItemId: string,
  next: InventoryCostUpdate,
): Promise<void> {
  await db
    .update(inventoryItems)
    .set({
      currentQuantity: qty(next.currentQuantity),
      lastUnitCost: unitCost(next.lastUnitCost),
      averageUnitCost: unitCost(next.averageUnitCost),
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, inventoryItemId));
}

/**
 * Rolls the weighted moving average forward over a purchase.
 *
 * `applyWeightedAverage` is the tested pure function in `pricing.ts`; this is
 * only the read-lock-write wrapper around it, kept here so both the worker and
 * the verify endpoint go through one implementation.
 */
export async function applyPurchase(
  db: InventoryDb,
  inventoryItemId: string,
  purchasedQuantity: number,
  unitPrice: number,
): Promise<void> {
  const snapshot = await lockInventoryRow(db, inventoryItemId);
  if (!snapshot) return;

  await writeInventoryState(
    db,
    inventoryItemId,
    applyWeightedAverage(snapshot, { quantity: purchasedQuantity, unitPrice }),
  );
}

/**
 * Applies `applyPurchase` off a snapshot the caller already holds the lock for,
 * so a receipt referencing one SKU from several lines locks it once instead of
 * once per line. A missing snapshot is a silent no-op, unchanged from when this
 * lived in `worker.ts`.
 *
 * Returns the state it wrote so a caller applying several lines to one SKU can
 * thread it forward. Without that, every line would compute from the same
 * pre-transaction snapshot and the last write would erase the ones before it.
 */
export async function applyPurchaseFrom(
  db: InventoryDb,
  inventoryItemId: string,
  purchasedQuantity: number,
  unitPrice: number,
  snapshot: InventorySnapshot | undefined,
): Promise<InventorySnapshot | undefined> {
  if (!snapshot) return undefined;

  const next = applyWeightedAverage(snapshot, { quantity: purchasedQuantity, unitPrice });
  await writeInventoryState(db, inventoryItemId, next);

  return {
    currentQuantity: qty(next.currentQuantity),
    averageUnitCost: unitCost(next.averageUnitCost),
  };
}

/**
 * Takes `amount` units back out of stock without touching the average cost.
 *
 * Stock leaving inventory leaves at the average cost it was carried at, so
 * `average_unit_cost` stays put and only the quantity moves — the same shape
 * `POST /inventory/adjust` uses. This is the negative-delta counterpart to
 * `applyPurchaseFrom`, which `applyWeightedAverage` cannot express because it
 * clamps a negative purchase to zero.
 */
export async function reduceStock(
  db: InventoryDb,
  inventoryItemId: string,
  amount: number,
  snapshot: InventorySnapshot | undefined,
): Promise<InventorySnapshot | undefined> {
  if (!snapshot || amount <= 0) return undefined;

  await db
    .update(inventoryItems)
    .set({
      currentQuantity: sql`greatest(${inventoryItems.currentQuantity} - ${amount}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(inventoryItems.id, inventoryItemId));

  // Mirrors the `greatest(..., 0)` above so a caller can chain further lines.
  return {
    currentQuantity: qty(Math.max(toNumber(snapshot.currentQuantity) - amount, 0)),
    averageUnitCost: snapshot.averageUnitCost,
  };
}
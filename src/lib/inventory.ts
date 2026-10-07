/**
 * Inventory writes used by the receipt verification endpoint.
 *
 * Since N-28 these belong to verification alone: the vision worker only
 * extracts line data and saves it with `inventory_item_id` null, so stock
 * never moves until a human accepts a line. Every function takes the handle it
 * writes through instead of reaching for a module-level client, so the caller's
 * whole receipt update stays inside one transaction.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { inventoryItems } from '../db/schema/index.js';
import { INVENTORY_UNITS, type InventoryUnit } from '../db/schema/enums.js';
import { quantity as qty, unitCost } from './money.js';
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

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export async function findInventoryItem(
  db: InventoryDb,
  shopId: string,
  rawName: string,
): Promise<string | null> {
  const name = rawName.trim();
  if (name.length === 0) return null;
  const normalized = normalizeName(name);

  const candidates = await db
    .select({ id: inventoryItems.id, name: inventoryItems.name })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.shopId, shopId)));

  for (const candidate of candidates) {
    if (normalizeName(candidate.name) === normalized) {
      return candidate.id;
    }
  }
  return null;
}

export async function findOrCreateInventoryItem(
  db: InventoryDb,
  shopId: string,
  rawName: string,
  unit: string | null,
  context?: 'receipt' | 'recipe' | 'generic',
): Promise<string | null> {
  const found = await findInventoryItem(db, shopId, rawName);
  if (found) return found;
  if (context === 'recipe') {
    return null;
  }

  const name = rawName.trim();
  if (name.length === 0) return null;

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
 * Applies a purchase off a snapshot the caller already holds the lock for, so a
 * receipt referencing one SKU from several lines locks it once instead of once
 * per line. A missing snapshot is a silent no-op.
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

/**
 * The verification transaction behind `POST /receipts/:id/verify`.
 *
 * Extracted from the route so the row-lock behaviour can be exercised directly
 * against a real Postgres. Locking, not arithmetic, is the substance here: a
 * transaction alone does not stop two verifications of receipts sharing a SKU
 * from both reading the same quantity before either writes, and the fix — locking
 * every affected inventory row in ascending id order — only means anything if it
 * survives contact with a real lock manager.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { receipts, receiptItems } from '../db/schema/index.js';
import { badRequest, conflict, notFound } from './errors.js';
import {
  applyPurchaseFrom,
  findOrCreateInventoryItem,
  lockInventoryRows,
  reduceStock,
} from './inventory.js';
import { money, quantity as qty, toNumber, unitCost } from './money.js';

export interface VerifyLineInput {
  id: string;
  accepted: boolean;
  rawName?: string;
  rawSku?: string;
  unit?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
}

export interface VerifyReceiptInput {
  db: Database;
  shopId: string;
  userId: string;
  receiptId: string;
  items: VerifyLineInput[];
}

export interface VerifyReceiptResult {
  receiptId: string;
  status: 'verified';
  accepted: number;
  rejected: number;
}

interface Decision {
  stored: { id: string; rawName: string; unit: string | null; quantity: string | null };
  submitted: VerifyLineInput;
  inventoryItemId: string | null;
  rawName: string;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  /** Signed stock movement: accepted minus what the worker already applied. */
  delta: number;
}

export async function verifyReceipt(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
  const { db, shopId, userId, receiptId, items } = input;

  return db.transaction(async (tx) => {
    const receiptRows = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, receiptId), eq(receipts.shopId, shopId)))
      .limit(1)
      .for('update');
    const receipt = receiptRows[0];
    if (!receipt) throw notFound('Receipt not found');

    // Verified exactly once. Refusing the second attempt with a 409 is what
    // makes this endpoint safe to retry: no retry can apply the purchase twice.
    // Taking the receipt lock above is what makes the check atomic rather than a
    // check-then-act race two parallel requests can both pass.
    if (receipt.status === 'verified') {
      throw conflict('Receipt is already verified');
    }

    const storedRows = await tx
      .select()
      .from(receiptItems)
      .where(and(eq(receiptItems.receiptId, receiptId), eq(receiptItems.shopId, shopId)));
    const byId = new Map(storedRows.map((row) => [row.id, row]));

    const foreign = items.find((item) => !byId.has(item.id));
    if (foreign) {
      throw badRequest(`Receipt line ${foreign.id} does not belong to this receipt`);
    }

    const decisions: Decision[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const submitted of items) {
      const stored = byId.get(submitted.id)!;
      const rawName = submitted.rawName ?? stored.rawName;
      const unit = submitted.unit ?? stored.unit;
      const quantity = submitted.quantity ?? toNumber(stored.quantity);
      const unitPrice = submitted.unitPrice ?? toNumber(stored.unitPrice);

      // A rejected line resolves no SKU and writes no stock movement. Creating one
      // anyway would leave inventory for something nobody bought.
      if (!submitted.accepted) {
        rejected += 1;
        decisions.push({
          stored,
          submitted,
          inventoryItemId: null,
          rawName,
          unit,
          quantity,
          unitPrice,
          delta: 0,
        });
        continue;
      }

      accepted += 1;
      const inventoryItemId = await findOrCreateInventoryItem(tx, shopId, rawName, unit);

      // A delta, never the full amount. The vision worker already moved stock for
      // every extracted line, so approval settles only the difference between
      // what was read off the document and what the reviewer accepted. Applying
      // the whole line again would double-count every receipt that reaches here.
      decisions.push({
        stored,
        submitted,
        inventoryItemId,
        rawName,
        unit,
        quantity,
        unitPrice,
        delta: quantity - toNumber(stored.quantity),
      });
    }

    // One lock acquisition for the whole receipt, always in ascending id order.
    // Locking per line as we walked the body would take the same rows in request
    // order, which is exactly how two receipts listing shared SKUs differently
    // deadlock each other.
    const snapshots = await lockInventoryRows(
      tx,
      decisions
        .map((decision) => decision.inventoryItemId)
        .filter((value): value is string => value !== null),
    );

    for (const decision of decisions) {
      if (!decision.inventoryItemId || decision.delta === 0) continue;

      // Thread the state forward within the loop. Two accepted lines naming the
      // same SKU both start from the locked snapshot; without carrying the result
      // of the first write into the second, the later write would silently drop
      // the earlier line's quantity and cost.
      const snapshot = snapshots.get(decision.inventoryItemId);
      const next =
        decision.delta > 0
          ? await applyPurchaseFrom(
              tx,
              decision.inventoryItemId,
              decision.delta,
              decision.unitPrice,
              snapshot,
            )
          : await reduceStock(tx, decision.inventoryItemId, -decision.delta, snapshot);

      if (next) snapshots.set(decision.inventoryItemId, next);
    }

    for (const decision of decisions) {
      const { stored, submitted } = decision;
      const patch: Record<string, unknown> = {
        inventoryItemId: decision.inventoryItemId,
        reviewStatus: submitted.accepted ? 'accepted' : 'rejected',
      };

      // Corrections land only when supplied. An omitted field means the reviewer
      // agreed with the extraction, not that they blanked it out.
      if (submitted.rawName !== undefined) patch.rawName = decision.rawName;
      // The column and its partial index exist, but nothing has ever written it.
      if (submitted.rawSku !== undefined) patch.rawSku = submitted.rawSku;
      if (submitted.unit !== undefined) patch.unit = decision.unit;
      if (submitted.quantity !== undefined) patch.quantity = qty(decision.quantity);
      if (submitted.unitPrice !== undefined) patch.unitPrice = unitCost(decision.unitPrice);
      if (submitted.totalPrice !== undefined) patch.totalPrice = money(submitted.totalPrice);

      await tx
        .update(receiptItems)
        .set(patch)
        .where(and(eq(receiptItems.id, stored.id), eq(receiptItems.receiptId, receiptId)));
    }

    const now = new Date();
    await tx
      .update(receipts)
      .set({
        status: 'verified',
        verifiedAt: now,
        verifiedBy: userId,
        progressStage: 'completed',
        progressMessage: 'Verified by a user',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(receipts.id, receiptId));

    return { receiptId, status: 'verified' as const, accepted, rejected };
  });
}
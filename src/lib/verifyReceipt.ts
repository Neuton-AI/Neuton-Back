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
  loadBaseUnitPurchases,
  writeInventoryMaterial,
  type BaseUnitPurchase,
} from './inventory.js';
import { addBaseUnitCostSample, convertInventoryAmount } from './inventoryBaseUnits.js';
import { money, quantity as qty, toNumber, unitCost } from './money.js';

export interface VerifyLineInput {
  id: string;
  accepted: boolean;
  rawName?: string;
  rawMaterialName?: string;
  rawSku?: string;
  srcUnit?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
  baseUnit?: string;
  baseUnitAmount?: number;
  baseUnitCost?: number;
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
  stored: { id: string; rawName: string; srcUnit: string | null; quantity: string | null };
  submitted: VerifyLineInput;
  inventoryItemId: string | null;
  rawName: string;
  rawMaterialName: string;
  srcUnit: string | null;
  quantity: number;
  unitPrice: number;
  baseUnit: string | null;
  baseUnitAmount: number | null;
  baseUnitCost?: number;
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
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw badRequest('Receipt lines must not be submitted more than once');
    }

    const decisions: Decision[] = [];
    let accepted = 0;
    let rejected = 0;

    // Match the deterministic history ordering for purchases within one receipt.
    for (const submitted of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const stored = byId.get(submitted.id)!;
      const rawName = submitted.rawName ?? stored.rawName;
      const rawMaterialName = submitted.rawMaterialName ?? stored.rawMaterialName ?? rawName;
      const srcUnit = submitted.srcUnit ?? stored.srcUnit;
      const quantity = submitted.quantity ?? toNumber(stored.quantity);
      const unitPrice = submitted.unitPrice ?? toNumber(stored.unitPrice);
      const baseUnit = submitted.baseUnit ?? stored.baseUnit;
      const baseUnitAmount = submitted.baseUnitAmount ??
        (stored.baseUnitAmount == null ? null : toNumber(stored.baseUnitAmount));

      const decision = {
        stored,
        submitted,
        rawName,
        rawMaterialName,
        srcUnit,
        quantity,
        unitPrice,
        baseUnit,
        baseUnitAmount,
      };

      // A rejected line resolves no SKU and writes no stock movement. Creating one
      // anyway would leave inventory for something nobody bought.
      if (!submitted.accepted) {
        rejected += 1;
        decisions.push({
          ...decision,
          inventoryItemId: null,
        });
        continue;
      }

      accepted += 1;
      const inventoryItemId = await findOrCreateInventoryItem(tx, shopId, rawName, srcUnit);

      // Nothing was applied before this moment, so the whole accepted quantity
      // is what goes into stock — there is no earlier contribution to net out
      // against. The vision worker only extracts; it has never moved a unit
      // since N-28. The 409 on an already-verified receipt above is what keeps
      // this running at most once per receipt, so there is no second full apply
      // to worry about either.
      decisions.push({
        ...decision,
        inventoryItemId,
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

    const purchaseHistory = new Map<string, BaseUnitPurchase[]>();

    for (const decision of decisions) {
      if (!decision.inventoryItemId) continue;

      const snapshot = snapshots.get(decision.inventoryItemId);
      if (!snapshot) continue;

      const baseUnit = decision.baseUnit ?? snapshot.baseUnit;
      const historyKey = `${decision.inventoryItemId}:${baseUnit}`;
      let history = purchaseHistory.get(historyKey);
      if (!history) {
        history = await loadBaseUnitPurchases(tx, shopId, decision.inventoryItemId, baseUnit);
        purchaseHistory.set(historyKey, history);
      }
      // Inventory now holds a total. Only receipt history can supply a missing
      // per-package measurement; reusing the inventory total would multiply it again.
      const baseUnitAmount = decision.baseUnitAmount ??
        toNumber(history[0]?.baseUnitAmount);
      const baseUnitCost = decision.submitted.baseUnitCost ??
        (baseUnitAmount > 0 ? decision.unitPrice / baseUnitAmount : 0);
      const samples = history.map((purchase) => toNumber(purchase.baseUnitCost));
      let baseUnitAverageCost = samples.length > 0
        ? samples.reduce((sum, cost) => sum + cost, 0) / samples.length
        : 0;
      if (decision.quantity > 0 && baseUnitAmount > 0) {
        baseUnitAverageCost = addBaseUnitCostSample(samples, Number(baseUnitCost.toFixed(6)));
        history.unshift({ baseUnitCost: baseUnitCost.toFixed(6), baseUnitAmount: qty(baseUnitAmount) });
        history.splice(20);
      }
      const totalBaseUnitAmount = convertInventoryAmount(
        toNumber(snapshot.baseUnitAmount), snapshot.baseUnit, baseUnit,
      ) + decision.quantity * baseUnitAmount;
      await writeInventoryMaterial(tx, decision.inventoryItemId, {
        rawMaterialName: decision.rawMaterialName,
        baseUnit,
        baseUnitAmount: totalBaseUnitAmount,
        baseUnitCost,
        baseUnitAverageCost,
      });
      snapshot.baseUnit = baseUnit;
      snapshot.baseUnitAmount = totalBaseUnitAmount.toFixed(3);
      decision.baseUnit = baseUnit;
      decision.baseUnitAmount = baseUnitAmount;
      decision.baseUnitCost = baseUnitCost;

      if (decision.quantity <= 0) continue;

      // Thread the state forward within the loop. Two accepted lines naming the
      // same SKU both start from the locked snapshot; without carrying the result
      // of the first write into the second, the later write would silently drop
      // the earlier line's quantity and cost.
      const next = await applyPurchaseFrom(
        tx,
        decision.inventoryItemId,
        decision.quantity,
        decision.unitPrice,
        snapshot,
      );

      if (next) snapshots.set(decision.inventoryItemId, next);
    }

    for (const decision of decisions) {
      const { stored, submitted } = decision;
      const patch: Record<string, unknown> = {
        inventoryItemId: decision.inventoryItemId,
      };

      // Corrections land only when supplied. An omitted field means the reviewer
      // agreed with the extraction, not that they blanked it out.
      if (submitted.rawName !== undefined) patch.rawName = decision.rawName;
      if (submitted.rawMaterialName !== undefined) patch.rawMaterialName = decision.rawMaterialName;
      // The column and its partial index exist, but nothing has ever written it.
      if (submitted.rawSku !== undefined) patch.rawSku = submitted.rawSku;
      if (submitted.srcUnit !== undefined) patch.srcUnit = decision.srcUnit;
      if (submitted.quantity !== undefined) patch.quantity = qty(decision.quantity);
      if (submitted.unitPrice !== undefined) patch.unitPrice = unitCost(decision.unitPrice);
      if (submitted.totalPrice !== undefined) patch.totalPrice = money(submitted.totalPrice);
      if (submitted.baseUnit !== undefined) patch.baseUnit = decision.baseUnit;
      if (submitted.baseUnitAmount !== undefined) patch.baseUnitAmount = qty(submitted.baseUnitAmount);
      if (decision.inventoryItemId) {
        patch.baseUnit = decision.baseUnit;
        patch.baseUnitAmount = qty(decision.baseUnitAmount ?? 0);
        patch.baseUnitCost = decision.baseUnitCost?.toFixed(6) ?? null;
      }

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

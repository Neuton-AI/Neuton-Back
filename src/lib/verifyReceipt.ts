import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { receipts, receiptItems, productMeasurements } from '../db/schema/index.js';
import { badRequest, conflict, notFound } from './errors.js';
import { applyPurchaseFrom, findOrCreateInventoryItem, lockInventoryRows } from './inventory.js';
import { money, quantity as qty, unitCost } from './money.js';
import { normalizePurchase } from './purchaseNormalization.js';
import { lookupExactProduct, type PriceChain } from './supermarket/prices.js';
import { productMeasurementKey } from './productIdentity.js';
import { normalizeMeasurement } from './measurements.js';
export { productMeasurementKey } from './productIdentity.js';

export interface VerifyLineInput {
  id: string; accepted: boolean; rawName?: string; rawSku?: string; codeChain?: PriceChain;
  unit?: string; quantity?: number; unitPrice?: number; totalPrice?: number;
  packageQuantity?: number; packageUnit?: string; packagesPerPurchase?: number;
  discountConfirmed?: boolean; saveProductMeasurement?: boolean;
}
export interface VerifyReceiptInput {
  db: Database; shopId: string; userId: string; receiptId: string; items: VerifyLineInput[];
  deferred?: boolean; currency?: string;
  lookup?: typeof lookupExactProduct;
}
export interface VerifyReceiptResult {
  receiptId: string; status: 'verified'; accepted: number; rejected: number; pending: number; applied: number;
}
/** External retrieval runs before write locks; the transaction rereads all data.
 * Only identity and package evidence is used, never the catalog's current price. */
export async function verifyReceipt(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
  const { db, shopId, userId, receiptId, items } = input;
  if (new Set(items.map(i => i.id)).size !== items.length) throw badRequest('Duplicate receipt decisions');
  const before = await db.select().from(receiptItems).where(and(eq(receiptItems.receiptId, receiptId), eq(receiptItems.shopId, shopId)));
  const enriched = new Map<string, Awaited<ReturnType<typeof lookupExactProduct>>>();
  for (const submitted of items) {
    const line = before.find(row => row.id === submitted.id);
    const code = submitted.rawSku ?? line?.rawSku;
    const chain = submitted.codeChain ?? line?.codeChain as PriceChain | undefined;
    const identityChanged = (submitted.rawSku != null && submitted.rawSku !== line?.rawSku) ||
      (submitted.codeChain != null && submitted.codeChain !== line?.codeChain);
    if (!submitted.accepted || !code || submitted.packageQuantity != null || (!identityChanged && line?.packageQuantity != null)) continue;
    try { enriched.set(submitted.id, await (input.lookup ?? lookupExactProduct)(code, chain)); } catch { /* Review remains available during outages. */ }
  }
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.id, receiptId), eq(receipts.shopId, shopId))).limit(1).for('update');
    if (!receipt) throw notFound('Receipt not found');
    if (!input.deferred && receipt.status === 'verified') throw conflict('Receipt is already verified');
    if (input.deferred && receipt.status !== 'verified') throw conflict('Verify receipt before resolving pending purchases');
    const storedRows = await tx.select().from(receiptItems).where(and(eq(receiptItems.receiptId, receiptId), eq(receiptItems.shopId, shopId)));
    if (items.some(i => !storedRows.some(row => row.id === i.id))) throw badRequest('Receipt line does not belong to this receipt');
    if (!input.deferred && storedRows.length !== items.length) throw badRequest('Review every receipt line');
    const decisions = [];
    let accepted = 0, rejected = 0, pending = 0, applied = 0;
    for (const submitted of items) {
      const stored = storedRows.find(row => row.id === submitted.id)!;
      if (input.deferred && (stored.applicationStatus !== 'pending' || stored.reviewStatus !== 'accepted')) throw conflict('Purchase has already been applied or was not accepted');
      let product = enriched.get(stored.id);
      const original = before.find(row => row.id === stored.id);
      // Do not apply an enrichment fetched for data edited while awaiting I/O.
      if (original && JSON.stringify(original) !== JSON.stringify(stored)) product = null;
      const rawName = submitted.rawName ?? stored.rawName;
      const rawSku = submitted.rawSku ?? stored.rawSku;
      const codeChain = submitted.codeChain ?? stored.codeChain;
      const key = productMeasurementKey(rawSku, codeChain);
      const identityChanged = rawSku !== stored.rawSku || codeChain !== stored.codeChain;
      let packageQuantity = submitted.packageQuantity ?? (identityChanged ? null : stored.packageQuantity);
      let packageUnit = submitted.packageUnit ?? (identityChanged ? null : stored.packageUnit);
      let packagesPerPurchase = submitted.packagesPerPurchase ?? (identityChanged ? null : stored.packagesPerPurchase);
      let source = packageQuantity != null ? 'receipt-or-confirmation' : 'unresolved';
      const [saved] = key ? await tx.select().from(productMeasurements).where(and(eq(productMeasurements.shopId, shopId), eq(productMeasurements.productKey, key))).limit(1) : [];
      if (packageQuantity == null && saved) {
        packageQuantity = saved.packageQuantity; packageUnit = saved.packageUnit;
        packagesPerPurchase ??= saved.packagesPerPurchase;
        source = 'shop-confirmed-product';
      }
      const catalogContents = product?.measurement?.measurement;
      if (packageQuantity == null && catalogContents) { packageQuantity = String(catalogContents.quantity); packageUnit = catalogContents.unit; source = 'exact-catalog'; }
      const purchase = normalizePurchase({ rawName, quantity: submitted.quantity ?? stored.quantity,
        unit: submitted.unit ?? stored.unit, unitPrice: submitted.unitPrice ?? stored.unitPrice,
        totalPrice: submitted.totalPrice ?? stored.totalPrice, packageQuantity, packageUnit,
        packagesPerPurchase,
        currency: receipt.currency, expectedCurrency: input.currency, discountConfirmed: submitted.discountConfirmed ?? (stored.measurementEvidence as { discountConfirmed?: boolean } | null)?.discountConfirmed });
      // A user confirmation resolves the conflict explicitly; otherwise retain it.
      const confirmedContents = normalizeMeasurement(packageQuantity, packageUnit).measurement;
      if (!submitted.packageQuantity && ((product?.measurement?.reason === 'conflicting_measurements') ||
        (catalogContents && confirmedContents && (Math.abs(confirmedContents.quantity - catalogContents.quantity) > 1e-6 || confirmedContents.unit !== catalogContents.unit)))) {
        purchase.state = 'unresolved'; purchase.reason = 'conflicting_measurements'; purchase.measurement = null; purchase.rate = null;
      }
      if (submitted.accepted) accepted++; else rejected++;
      const inventoryItemId = null as string | null;
      decisions.push({ submitted, stored, rawName, rawSku, codeChain, packageQuantity, packageUnit, packagesPerPurchase, key, purchase, inventoryItemId, source, product });
    }
    // Unique-key conflicts on newly created items also acquire database locks.
    // Resolve names in the same order before taking the sorted inventory locks.
    for (const decision of [...decisions].sort((a, b) => a.rawName.trim().toLowerCase().localeCompare(b.rawName.trim().toLowerCase()))) {
      if (decision.submitted.accepted && decision.purchase.measurement) decision.inventoryItemId =
        await findOrCreateInventoryItem(tx, shopId, decision.rawName, decision.purchase.measurement.unit);
    }
    const snapshots = await lockInventoryRows(tx, decisions.map(d => d.inventoryItemId).filter((id): id is string => !!id));
    for (const d of decisions) {
      const snapshot = d.inventoryItemId ? snapshots.get(d.inventoryItemId) : undefined;
      if (d.submitted.accepted && d.purchase.measurement && d.inventoryItemId) {
        if (!snapshot || snapshot.measurementStatus !== 'ready' || snapshot.unit !== d.purchase.measurement.unit || Number(snapshot.currentQuantity) > 0 && snapshot.averageUnitCost == null) {
          d.purchase.state = 'unresolved'; d.purchase.reason = snapshot?.measurementStatus !== 'ready' ? 'legacy_reconciliation_required' : snapshot.averageUnitCost == null && Number(snapshot.currentQuantity) > 0 ? 'missing_inventory_cost' : 'incompatible_inventory_unit';
        } else {
          const next = await applyPurchaseFrom(tx, d.inventoryItemId, d.purchase.measurement.quantity, d.purchase.rate!, snapshot);
          if (next) { snapshots.set(d.inventoryItemId, next); applied++; }
        }
      }
      const isApplied = d.submitted.accepted && d.purchase.state !== 'unresolved' && !!snapshot;
      if (d.submitted.accepted && !isApplied) pending++;
      const evidence = { original: { quantity: d.stored.quantity, unit: d.stored.unit, totalPrice: d.stored.totalPrice },
        source: d.source, product: d.product?.evidence, provenance: d.purchase.provenance,
        paidAmount: d.purchase.paidAmount, confirmedBy: userId,
        saveProductMeasurement: d.submitted.saveProductMeasurement ?? (d.stored.measurementEvidence as { saveProductMeasurement?: boolean } | null)?.saveProductMeasurement ?? false,
        discountConfirmed: d.submitted.discountConfirmed ?? (d.stored.measurementEvidence as { discountConfirmed?: boolean } | null)?.discountConfirmed ?? false };
      await tx.update(receiptItems).set({ rawName: d.rawName, rawSku: d.rawSku, codeChain: d.codeChain,
        unit: d.submitted.unit ?? d.stored.unit,
        quantity: d.submitted.quantity == null ? d.stored.quantity : qty(d.submitted.quantity),
        unitPrice: d.submitted.unitPrice == null ? d.stored.unitPrice : unitCost(d.submitted.unitPrice),
        totalPrice: d.submitted.totalPrice == null ? d.stored.totalPrice : money(d.submitted.totalPrice),
        packageQuantity: d.packageQuantity == null ? null : qty(Number(d.packageQuantity)), packageUnit: d.packageUnit,
        packagesPerPurchase: d.packagesPerPurchase == null ? null : qty(Number(d.packagesPerPurchase)),
        inventoryItemId: d.inventoryItemId, reviewStatus: d.submitted.accepted ? 'accepted' : 'rejected',
        measurementStatus: d.purchase.state, measurementReason: d.purchase.reason, measurementEvidence: evidence,
        normalizedQuantity: d.purchase.measurement ? qty(d.purchase.measurement.quantity) : null,
        normalizedUnit: d.purchase.measurement?.unit ?? null, normalizedRate: d.purchase.rate == null ? null : unitCost(d.purchase.rate),
        applicationStatus: isApplied ? 'applied' : d.submitted.accepted ? 'pending' : 'rejected',
        appliedAt: isApplied ? new Date() : null,
      }).where(and(eq(receiptItems.id, d.stored.id), eq(receiptItems.shopId, shopId)));
      if ((d.submitted.saveProductMeasurement ?? (d.stored.measurementEvidence as { saveProductMeasurement?: boolean } | null)?.saveProductMeasurement) && d.key && d.packageQuantity != null && d.packageUnit && d.purchase.state !== 'unresolved') {
        const metadata = { shopId, productKey: d.key, packageQuantity: qty(Number(d.packageQuantity)), packageUnit: d.packageUnit,
          packagesPerPurchase: qty(Number(d.packagesPerPurchase ?? 1)), evidence, updatedAt: new Date() };
        await tx.insert(productMeasurements).values(metadata).onConflictDoUpdate({ target: [productMeasurements.shopId, productMeasurements.productKey], set: metadata });
      }
    }
    await tx.update(receipts).set({ status: 'verified', verifiedAt: receipt.verifiedAt ?? new Date(), verifiedBy: receipt.verifiedBy ?? userId,
      progressStage: 'completed', progressMessage: pending ? 'Verified; some purchases need measurements' : 'Verified by a user', errorMessage: null, updatedAt: new Date(),
    }).where(eq(receipts.id, receiptId));
    return { receiptId, status: 'verified', accepted, rejected, pending, applied };
  });
}

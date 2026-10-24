import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import { receipts, receiptItems, mediaUploads } from '../../db/schema/index.js';
import type { Receipt, ReceiptItem } from '../../db/schema/receipts.js';
import { conflict, notFound } from '../../lib/errors.js';
import { scheduleObjectDeletions } from '../../lib/storageCleanup.js';
import { verifyReceipt } from '../../lib/verifyReceipt.js';
import type {
  ReceiptDto,
  ReceiptItemDto,
  ReceiptQuery,
  ReceiptPatchInput,
  ReceiptDetailDto,
  ReceiptStatusDto,
  VerifyReceiptInput,
} from './contracts.js';
export const RECEIPTS_DATABASE = Symbol('RECEIPTS_DATABASE');
export type ReceiptTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];
export type ReceiptDatabase = Database | ReceiptTransaction;
export function mapReceipt(row: Receipt): ReceiptDto {
  return {
    id: row.id,
    shopId: row.shopId,
    uploadedBy: row.uploadedBy,
    storagePath: row.storagePath,
    contentType: row.contentType,
    originalFilename: row.originalFilename,
    merchantName: row.merchantName,
    merchantAddress: row.merchantAddress,
    receiptDate: row.receiptDate,
    paymentMethod: row.paymentMethod,
    totalAmount: row.totalAmount,
    taxAmount: row.taxAmount,
    currency: row.currency,
    status: row.status,
    progressStage: row.progressStage,
    progressMessage: row.progressMessage,
    processingStartedAt: row.processingStartedAt?.toISOString() ?? null,
    processingDeadline: row.processingDeadline?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    processedAt: row.processedAt?.toISOString() ?? null,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapReceiptItem(row: ReceiptItem): ReceiptItemDto {
  return {
    id: row.id,
    shopId: row.shopId,
    receiptId: row.receiptId,
    inventoryItemId: row.inventoryItemId,
    rawName: row.rawName,
    rawMaterialName: row.rawMaterialName,
    rawSku: row.rawSku,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    totalPrice: row.totalPrice,
    rawSrcUnit: row.rawSrcUnit,
    srcUnit: row.srcUnit,
    srcUnitAmount: row.srcUnitAmount,
    baseUnit: row.baseUnit,
    baseUnitAmount: row.baseUnitAmount,
    baseUnitCost: row.baseUnitCost,
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ReceiptsPersistence {
  constructor(
    @Inject(RECEIPTS_DATABASE) readonly database: ReceiptDatabase = db,
  ) {}
  async list(shopId: string, query: ReceiptQuery): Promise<ReceiptDto[]> {
    const conditions = [eq(receipts.shopId, shopId)];
    if (query.status) conditions.push(eq(receipts.status, query.status));
    if (query.search)
      conditions.push(
        or(
          ilike(receipts.merchantName, '%' + query.search + '%'),
          ilike(receipts.originalFilename, '%' + query.search + '%'),
        )!,
      );
    const rows = await this.database
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.receiptDate), desc(receipts.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    return rows.map(mapReceipt);
  }
  async find(shopId: string, id: string): Promise<ReceiptDto> {
    const [receipt] = await this.database
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shopId)))
      .limit(1);
    if (!receipt) throw notFound('Receipt not found');
    return mapReceipt(receipt);
  }
  async status(shopId: string, id: string): Promise<ReceiptStatusDto> {
    const [row] = await this.database
      .select({
        status: receipts.status,
        errorMessage: receipts.errorMessage,
        progressStage: receipts.progressStage,
        progressMessage: receipts.progressMessage,
        processingStartedAt: receipts.processingStartedAt,
        processingDeadline: receipts.processingDeadline,
      })
      .from(receipts)
      .where(and(eq(receipts.id, id), eq(receipts.shopId, shopId)))
      .limit(1);
    if (!row) throw notFound('Receipt not found');
    return {
      status: row.status,
      errorMessage: row.errorMessage,
      progressStage: row.progressStage,
      progressMessage: row.progressMessage,
      processingStartedAt: row.processingStartedAt?.toISOString() ?? null,
      processingDeadline: row.processingDeadline?.toISOString() ?? null,
    };
  }
  async detail(shopId: string, id: string): Promise<ReceiptDetailDto> {
    const receipt = await this.find(shopId, id);
    const items = await this.database
      .select()
      .from(receiptItems)
      .where(
        and(eq(receiptItems.receiptId, id), eq(receiptItems.shopId, shopId)),
      )
      .orderBy(asc(receiptItems.id));
    const [upload] = await this.database
      .select({ sources: mediaUploads.sources })
      .from(mediaUploads)
      .where(
        and(eq(mediaUploads.receiptId, id), eq(mediaUploads.shopId, shopId)),
      )
      .limit(1);
    return {
      ...receipt,
      items: items.map(mapReceiptItem),
      sources: (upload?.sources ?? []).map((source) => ({
        sourceId: source.sourceId,
        storagePath: source.storagePath,
        contentType: source.contentType,
        originalFilename: source.originalFilename,
        byteSize: source.byteSize,
      })),
    };
  }
  async pending(shopId: string) {
    const [row] = await this.database
      .select({ count: sql.raw('count(*)::int').mapWith(Number) })
      .from(receipts)
      .where(
        and(
          eq(receipts.shopId, shopId),
          inArray(receipts.status, ['pending', 'processing']),
        ),
      );
    return row?.count ?? 0;
  }
  edit(shopId: string, id: string, input: ReceiptPatchInput): Promise<ReceiptDto> {
    return this.database.transaction(async (tx) => {
      const [existing] = await tx.select({ status: receipts.status })
        .from(receipts).where(and(eq(receipts.id, id), eq(receipts.shopId, shopId)))
        .limit(1).for('update');
      if (!existing) throw notFound('Receipt not found');
      if (existing.status !== 'unverified' && existing.status !== 'verified')
        throw conflict('Receipt must finish extraction before editing');
      const [row] = await tx.update(receipts)
        .set({ merchantName: input.merchantName, updatedAt: new Date() })
        .where(and(eq(receipts.id, id), eq(receipts.shopId, shopId))).returning();
      return mapReceipt(row!);
    });
  }
  verify(
    shopId: string,
    userId: string,
    id: string,
    input: VerifyReceiptInput,
  ) {
    return verifyReceipt({
      db: this.database as Database,
      shopId,
      userId,
      receiptId: id,
      items: input.items,
    });
  }
  delete(shopId: string, id: string, traceId: string) {
    return this.database.transaction(async (tx) => {
      const [receipt] = await tx
        .select({ status: receipts.status, storagePath: receipts.storagePath })
        .from(receipts)
        .where(and(eq(receipts.id, id), eq(receipts.shopId, shopId)))
        .limit(1)
        .for('update');
      if (!receipt) throw notFound('Receipt not found');
      if (receipt.status === 'verified')
        throw conflict(
          'A verified receipt already moved stock and counted as spend; it cannot be deleted',
        );
      const uploads = await tx
        .select({ sources: mediaUploads.sources })
        .from(mediaUploads)
        .where(
          and(eq(mediaUploads.receiptId, id), eq(mediaUploads.shopId, shopId)),
        );
      await scheduleObjectDeletions(tx, {
        shopId,
        traceId,
        paths: [
          receipt.storagePath,
          ...uploads.flatMap((upload) =>
            upload.sources.map((source) => source.storagePath),
          ),
        ],
      });
      await tx
        .delete(receipts)
        .where(and(eq(receipts.id, id), eq(receipts.shopId, shopId)));
    });
  }
}

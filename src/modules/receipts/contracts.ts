import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { RECEIPT_STATUSES } from '../../db/schema/enums.js';
export const verifyItemSchema = z.object({
  id: z.string().uuid(),
  accepted: z.boolean(),
  rawName: htmlFree(z.string().trim().min(1).max(200)).optional(),
  rawMaterialName: htmlFree(z.string().trim().min(1).max(160)).optional(),
  rawSku: htmlFree(z.string().trim().min(1).max(120)).optional(),
  srcUnit: htmlFree(z.string().trim().min(1).max(20)).optional(),
  quantity: z.coerce.number().min(0).optional(),
  unitPrice: z.coerce.number().min(0).optional(),
  totalPrice: z.coerce.number().min(0).optional(),
  baseUnit: htmlFree(z.string().trim().min(1).max(24)).optional(),
  baseUnitAmount: z
    .number()
    .finite()
    .nonnegative()
    .max(999999999.999)
    .optional(),
  baseUnitCost: z
    .number()
    .finite()
    .nonnegative()
    .lt(1_000_000_000_000)
    .optional(),
});

export const verifySchema = z.object({
  items: z.array(verifyItemSchema).min(1).max(500),
});

export const receiptIdSchema = z.object({ id: z.string().uuid() });
export const receiptPatchSchema = z.object({
  merchantName: htmlFree(z.string().trim().min(1).max(200)),
}).strict();
export type ReceiptPatchInput = z.infer<typeof receiptPatchSchema>;
export const receiptQuerySchema = z.object({
  status: z.enum(RECEIPT_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();
export type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
export type VerifyReceiptInput = z.infer<typeof verifySchema>;
export interface ReceiptDto {
  id: string;
  shopId: string;
  uploadedBy: string | null;
  storagePath: string | null;
  contentType: string | null;
  originalFilename: string | null;
  merchantName: string | null;
  merchantAddress: string | null;
  receiptDate: string | null;
  paymentMethod: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  currency: string | null;
  status: string;
  progressStage: string | null;
  progressMessage: string | null;
  processingStartedAt: string | null;
  processingDeadline: string | null;
  errorMessage: string | null;
  processedAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptItemDto {
  id: string;
  shopId: string;
  receiptId: string;
  inventoryItemId: string | null;
  rawName: string;
  rawMaterialName: string;
  rawSku: string | null;
  quantity: string | null;
  unitPrice: string | null;
  totalPrice: string | null;
  rawSrcUnit: string | null;
  srcUnit: string | null;
  srcUnitAmount: string | null;
  baseUnit: string | null;
  baseUnitAmount: string | null;
  baseUnitCost: string | null;
  confidence: string | null;
  createdAt: string;
}

export interface ReceiptSourceDto {
  sourceId: string;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  byteSize: number;
}
export interface ReceiptDetailDto extends ReceiptDto {
  items: ReceiptItemDto[];
  sources: ReceiptSourceDto[];
}
export type ReceiptStatusDto = Pick<
  ReceiptDto,
  | 'status'
  | 'errorMessage'
  | 'progressStage'
  | 'progressMessage'
  | 'processingStartedAt'
  | 'processingDeadline'
>;

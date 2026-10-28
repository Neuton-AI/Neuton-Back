import type { SourcePreview } from '../../db/schema/uploads.js';
import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { ORDER_STATUSES } from '../../db/schema/enums.js';
export const orderItemSchema = z.object({
  recipeId: z.string().uuid(),
  /**
   * A line item is a count of whole units; the New Order stepper only ever
   * emits integers, so a fractional quantity is a client bug and is rejected
   * here rather than silently scaled through the pricing.
   */
  quantity: z.coerce
    .number()
    .int('Quantity must be a positive integer')
    .positive('Quantity must be a positive integer')
    .max(100000),
  /** Optional override; when omitted the recipe retail price is used. */
  unitPrice: z.coerce.number().min(0).nullable().optional(),
});
export const createOrderSchema = z.object({
  customerName: htmlFree(z.string().trim().max(160)).nullable().optional(),
  orderDate: z.coerce.date().optional(),
  destinationAddress: htmlFree(z.string().trim().max(300)).nullable().optional(),
  deliveryDistanceKm: z.coerce.number().min(0).max(20000).default(0),
  documentUrl: htmlFree(z.string().trim().max(500)).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
});
export const orderIdSchema = z.object({ id: z.string().uuid() });
export const listOrdersSchema = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  search: z.string().trim().max(120).optional(), status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
}).strict();
export const quoteOrderSchema = z.object({ deliveryDistanceKm: z.coerce.number().min(0).default(0), items: z.array(orderItemSchema).min(1) });
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type QuoteOrderInput = z.infer<typeof quoteOrderSchema>;
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
/** Decimal columns intentionally remain strings; date columns serialize as ISO timestamps. */
export interface OrderDto {
  id: string;
  orderNumber: number;
  shopId: string;
  userId: string | null;
  customerName: string | null;
  orderDate: string;
  destinationAddress: string | null;
  deliveryDistanceKm: string;
  deliveryFee: string;
  appliedProfitMargin: string | null;
  totalCost: string;
  totalAmount: string;
  documentUrl: string | null;
  status: string;
  createdAt: string;
  deletedAt: string | null;
}
export interface OrderItemDto {
  id: string;
  recipeId: string;
  name: string;
  quantity: string;
  unitCost: string;
  unitPrice: string;
}
export interface PricedOrderItem {
  recipeId: string;
  name: string;
  quantity: number;
  unitCost: number;
  unitPrice: number;
  appliedProfitMargin: number;
  retailPrice: number;
}
export interface OrderTotals {
  totalCost: number;
  totalAmount: number;
  deliveryFee: number;
  netProfit: number;
  profitMarginPercent: number;
}
export interface QuoteOrderOutput extends OrderTotals {
  items: PricedOrderItem[];
  deliveryDistanceKm: number;
  baseFee: number;
  ratePerKm: number;
}
export interface CreateOrderOutput {
  order: OrderDto;
  totals: OrderTotals;
}
export interface ListOrdersOutput {
  orders: (OrderDto & {
    netProfit: number;
  })[];
  total: number;
}
export interface OrderSourceDto {
  preview?: SourcePreview;
  sourceId: string;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  byteSize: number;
}
export interface OrderDetailOutput {
  order: OrderDto & {
    items: OrderItemDto[];
    sources: OrderSourceDto[];
    netProfit: number;
  };
}

export interface OrderMutationOutput { order: OrderDto }

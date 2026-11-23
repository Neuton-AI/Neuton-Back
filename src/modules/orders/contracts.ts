import type { SourcePreview } from '../../db/schema/uploads.js';
import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';
import { ORDER_STATUSES } from '../../db/schema/enums.js';

export const undoDeliverySchema = z.object({ confirmedMarkedByMistake: z.literal(true) }).strict();
export const recordPaymentSchema = z.object({
  kind: z.enum(['deposit', 'payment']),
  amount: z.string().regex(/^(0|[1-9]\d{0,7})\.\d{2}$/)
    .refine(amount => amount !== '0.00', 'Payment must be positive'),
  occurredAt: z.string().datetime({ offset: true })
    .refine(value => !value.startsWith('0000-') && Number.isFinite(Date.parse(value)), 'Invalid payment timestamp')
    .transform(value => new Date(value)),
}).strict();
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
const deliveryFeeSchema = z.union([
  z.number().finite().min(0).max(99_999_999.99).multipleOf(0.01),
  z.string().max(11).regex(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/).transform(Number),
]);
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
  /** The price shown to the user, compared by atomic review; never an override. */
  expectedUnitPrice: z.string().max(11).regex(/^(0|[1-9]\d{0,7})\.\d{2}$/).optional(),
  /** Legacy override, incompatible with expectedUnitPrice. */
  unitPrice: z.coerce.number().min(0).nullable().optional(),
});
export const createOrderSchema = z.object({
  customerName: htmlFree(z.string().trim().min(1).max(160)),
  orderDate: z.coerce.date().optional(),
  /** Legacy clients may omit this; omission is stored as null. */
  deliveryDate: z.string().date().refine(value => !value.startsWith('0000-'), 'Date must have a nonzero year').optional(),
  destinationAddress: htmlFree(z.string().trim().min(1).max(300)),
  deliveryFee: deliveryFeeSchema.optional(),
  documentUrl: htmlFree(z.string().trim().max(500)).nullable().optional(),
  items: z.array(orderItemSchema).min(1).max(100),
  confirmedUnavailableRecipeIds: z.array(z.string().uuid()).max(100).optional(),
}).superRefine((body, context) => {
  const isReviewed = body.confirmedUnavailableRecipeIds !== undefined ||
    body.items.some(item => item.expectedUnitPrice !== undefined);
  if (isReviewed && body.deliveryDate === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryDate'],
      message: 'Delivery date is required for a reviewed order' });
  }
  const confirmedIds = body.confirmedUnavailableRecipeIds ?? [];
  const submittedIds = new Set(body.items.map(item => item.recipeId));
  if (new Set(confirmedIds).size !== confirmedIds.length || confirmedIds.some(id => !submittedIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmedUnavailableRecipeIds'],
      message: 'Confirmed exclusions must be unique submitted recipe IDs' });
  }
  body.items.forEach((item, index) => {
    if (item.expectedUnitPrice !== undefined && item.unitPrice !== undefined && item.unitPrice !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'unitPrice'],
        message: 'An expected price cannot be combined with a price override' });
    }
  });
});
export const orderIdSchema = z.object({ id: z.string().uuid() });
const savedOrderItemSchema = z.object({
  lineId: z.string().uuid(),
  quantity: z.number().positive().max(999_999_999.999).multipleOf(0.001),
}).strict();
const newOrderItemSchema = orderItemSchema.pick({ recipeId: true, quantity: true }).extend({
  expectedUnitPrice: orderItemSchema.shape.expectedUnitPrice.unwrap(),
}).strict();
export const updateOrderSchema = z.object({
  customerName: htmlFree(z.string().trim().min(1).max(160)).optional(),
  destinationAddress: htmlFree(z.string().trim().min(1).max(300)).optional(),
  orderDate: z.string().datetime({ offset: true }).transform(value => new Date(value)).optional(),
  deliveryDate: z.string().date().refine(value => !value.startsWith('0000-')).nullable().optional(),
  deliveryFee: deliveryFeeSchema,
  items: z.array(z.union([savedOrderItemSchema, newOrderItemSchema])).min(1).max(100),
  confirmedUnavailableRecipeIds: z.array(z.string().uuid()).max(100).optional(),
}).strict().superRefine((body, context) => {
  const saved = body.items.filter(item => 'lineId' in item).map(item => item.lineId);
  const added = body.items.filter(item => 'recipeId' in item).map(item => item.recipeId);
  const confirmed = body.confirmedUnavailableRecipeIds ?? [];
  if (new Set(saved).size !== saved.length || new Set(added).size !== added.length ||
      new Set(confirmed).size !== confirmed.length || confirmed.some(id => !added.includes(id))) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Order lines and confirmed exclusions must be unique and valid.' });
  }
});
export const listOrdersSchema = z.object({
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  search: z.string().trim().max(120).optional(), status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
}).strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
/** Decimals remain strings; deliveryDate is YYYY-MM-DD, timestamps are ISO. */
export interface OrderDto {
  id: string;
  orderNumber: number;
  shopId: string;
  userId: string | null;
  customerName: string | null;
  orderDate: string;
  deliveryDate: string | null;
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
  /** null means the historical completeness was not recorded. */
  costComplete: boolean | null;
  unitCost: string;
  unitPrice: string;
}
export interface PricedOrderItem {
  recipeId: string;
  name: string;
  quantity: number;
  costComplete: boolean;
  unitCost: number;
  unitPrice: number;
  appliedProfitMargin: number;
}
export interface OrderTotals {
  totalCost: number;
  totalAmount: number;
  deliveryFee: number;
  netProfit: number;
  profitMarginPercent: number;
}
export interface CreateOrderOutput {
  order: OrderDto;
  totals: OrderTotals;
}
export interface ListOrdersOutput {
  orders: (OrderDto & {
    netProfit: number;
    paymentSummary: OrderPaymentSummary;
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
    paymentSummary: OrderPaymentSummary;
    paymentHistory: OrderPaymentDto[];
  };
}

export interface OrderMutationOutput { order: OrderDto }

export interface OrderPaymentSummary {
  status: 'unpaid' | 'deposited' | 'paid' | 'pending_refund' | 'refunded';
  totalReceived: string;
  balanceDue: string;
  refundDue: string;
  depositAmount: string;
  depositDate: string | null;
}

export interface OrderPaymentDto {
  id: string;
  kind: 'deposit' | 'payment' | 'refund';
  amount: string;
  occurredAt: string;
  recordedAt: string;
  recordedByUserId: string | null;
}

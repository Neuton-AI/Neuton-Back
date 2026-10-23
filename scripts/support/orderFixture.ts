import type { Order } from '../../src/db/schema/orders.js';
export function orderRow(overrides: Partial<Order> = {}): Order {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    shopId: '22222222-2222-2222-2222-222222222222',
    orderNumber: 1,
    userId: null,
    customerName: null,
    orderDate: new Date('2026-06-15'),
    destinationAddress: null,
    deliveryDistanceKm: '0.00',
    deliveryFee: '0.00',
    appliedProfitMargin: null,
    totalCost: '0.00',
    totalAmount: '0.00',
    documentUrl: null,
    status: 'processing',
    createdAt: new Date('2026-06-15'),
    deletedAt: null,
    ...overrides,
  };
}

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import { orders, orderItems, orderItemRecipeName, orderPayments, recipes, shops, mediaUploads, recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import type { Order } from '../../db/schema/orders.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import { orderProfitCorrection } from '../../lib/orderProfit.js';
import { money, quantity as qty } from '../../lib/money.js';
import { retryTransaction } from '../../lib/transactionRetry.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { CreateOrderInput, ListOrdersInput, OrderDto, PricedOrderItem, OrderTotals, UpdateOrderInput } from './contracts.js';
export const ORDERS_DATABASE = Symbol('ORDERS_DATABASE');
export type OrdersTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export function mapOrder(order: Order): OrderDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    shopId: order.shopId,
    userId: order.userId,
    customerName: order.customerName,
    orderDate: order.orderDate.toISOString(),
    deliveryDate: order.deliveryDate ?? null,
    destinationAddress: order.destinationAddress,
    deliveryDistanceKm: order.deliveryDistanceKm,
    deliveryFee: order.deliveryFee,
    appliedProfitMargin: order.appliedProfitMargin,
    totalCost: order.totalCost,
    totalAmount: order.totalAmount,
    documentUrl: order.documentUrl,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    deletedAt: order.deletedAt?.toISOString() ?? null,
  };
}
@Injectable()
export class OrdersPersistence {
  constructor(@Inject(ORDERS_DATABASE) readonly database: Database | OrdersTransaction = db) {}
  async runSerializable<T>(operation: (tx: OrdersTransaction) => Promise<T>): Promise<T> {
    return retryTransaction(() => this.database.transaction(async (tx) => {
      await tx.setTransaction({ isolationLevel: 'serializable' });
      return operation(tx);
    }));
  }
  async currentShop(shopId: string) {
    const [shop] = await this.database.select().from(shops).where(eq(shops.id, shopId)).limit(1);
    if (!shop) throw notFound('Shop not found');
    return shop;
  }
  async pricingInputs(shopId: string, recipeIds: string[]) {
    const recipeRows = await this.database
      .select()
      .from(recipes)
      .where(and(eq(recipes.shopId, shopId), inArray(recipes.id, recipeIds)))
      .orderBy(asc(recipes.id))
      .for('key share');
    const ingredientRows = await this.database
      .select({
        recipeId: recipeIngredients.recipeId,
        quantity: recipeIngredients.baseUnitAmount,
        averageUnitCost: recipeIngredientUnitCost,
      })
      .from(recipeIngredients)
      .leftJoin(inventoryItems, and(eq(inventoryItems.id, recipeIngredients.inventoryItemId), eq(inventoryItems.shopId, shopId)))
      .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
      .where(and(eq(recipeIngredients.shopId, shopId), inArray(recipeIngredients.recipeId, recipeIds)));
    return { recipeRows, ingredientRows };
  }
  async list(shopId: string, query: ListOrdersInput) {
    const conditions = [eq(orders.shopId, shopId), isNull(orders.deletedAt)];
    if (query.from)
      conditions.push(sql`${orders.orderDate} >= ${query.from}`);
    if (query.to)
      conditions.push(sql`${orders.orderDate} <= ${query.to}`);
    if (query.search) {
      conditions.push(sql`${orders.customerName} ilike ${`%${query.search}%`}`);
    }
    if (query.status)
      conditions.push(eq(orders.status, query.status));
    const rows = await this.database
      .select({ ...getTableColumns(orders), profitCorrection: orderProfitCorrection })
      .from(orders)
      .where(and(...conditions))
      // Secondary key is the invoice number (N-105): it is issued in creation
      // order, so within a day the listing is the sequence itself and ties no
      // longer depend on how `created_at` happens to sort.
      .orderBy(desc(orders.orderDate), desc(orders.orderNumber))
      .limit(query.limit)
      .offset(query.offset);
    const totalRows = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(...conditions));
    return { rows, total: totalRows[0]?.count ?? 0 };
  }
  async find(shopId: string, id: string) {
    const [order] = await this.database.select({ ...getTableColumns(orders), profitCorrection: orderProfitCorrection }).from(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shopId), isNull(orders.deletedAt))).limit(1);
    if (!order)
      throw notFound('Order not found');
    return order;
  }
  async paymentHistory(shopId: string, ids: string[]) {
    if (!ids.length) return new Map<string, (typeof orderPayments.$inferSelect)[]>();
    const rows = await this.database.select(getTableColumns(orderPayments)).from(orderPayments)
      .innerJoin(orders, and(eq(orders.id, orderPayments.orderId), eq(orders.shopId, shopId), isNull(orders.deletedAt)))
      .where(inArray(orderPayments.orderId, ids))
      .orderBy(asc(orderPayments.occurredAt), asc(orderPayments.recordedAt), asc(orderPayments.id));
    const history = new Map<string, typeof rows>();
    for (const row of rows) {
      const payments = history.get(row.orderId);
      if (payments) payments.push(row);
      else history.set(row.orderId, [row]);
    }
    return history;
  }
  async detailLines(shopId: string, id: string) {
    const items = await this.database
      .select({
        id: orderItems.id,
        recipeId: orderItems.recipeId,
        // Snapshot first: renaming a recipe must not rewrite orders that
        // already went out, and a recipe with no row left must not take its
        // lines down with it.
        name: orderItemRecipeName,
        quantity: orderItems.quantity,
        costComplete: orderItems.costComplete,
        unitCost: orderItems.unitCost,
        unitPrice: orderItems.unitPrice,
      })
      .from(orderItems)
      .leftJoin(recipes, and(eq(recipes.id, orderItems.recipeId), eq(recipes.shopId, shopId)))
      .where(and(eq(orderItems.orderId, id), eq(orderItems.shopId, shopId)))
      .orderBy(asc(orderItems.id));
    const uploads = await this.database.select({ sources: mediaUploads.sources }).from(mediaUploads)
      .where(and(eq(mediaUploads.orderId, id), eq(mediaUploads.shopId, shopId)))
      .orderBy(asc(mediaUploads.createdAt));
    return {
      items,
      sources: uploads.flatMap(upload => upload.sources.map(source => ({
        sourceId: source.sourceId,
        storagePath: source.storagePath,
        contentType: source.contentType,
        originalFilename: source.originalFilename,
        byteSize: source.byteSize,
        ...(source.preview ? { preview: source.preview } : {}),
      }))),
    };
  }
  async create(shopId: string, userId: string, body: CreateOrderInput & { orderDate: Date }, priced: PricedOrderItem[], totals: OrderTotals, transaction?: OrdersTransaction) {
    const write = async (tx: OrdersTransaction) => {
      // One `UPDATE … RETURNING` both claims the next number and locks the
      // shop row until this transaction ends (N-105): concurrent creates queue
      // behind it, so they read the row the previous one wrote and can neither
      // duplicate nor skip a number. A create that rolls back takes its number
      // back with it, and nothing ever reuses a number that was issued.
      const [counter] = await tx
        .update(shops)
        .set({ lastOrderNumber: sql`${shops.lastOrderNumber} + 1` })
        .where(eq(shops.id, shopId))
        .returning({ lastOrderNumber: shops.lastOrderNumber });
      if (!counter)
        throw new Error('Shop row missing while allocating order number');
      const inserted = await tx
        .insert(orders)
        .values({
          orderNumber: counter.lastOrderNumber,
          shopId: shopId,
          userId: userId,
          customerName: body.customerName ?? null,
          orderDate: body.orderDate,
          deliveryDate: body.deliveryDate ?? null,
          destinationAddress: body.destinationAddress ?? null,
          deliveryDistanceKm: '0.00',
          deliveryFee: money(totals.deliveryFee),
          appliedProfitMargin: priced[0]?.appliedProfitMargin !== undefined
            ? priced[0].appliedProfitMargin.toFixed(2)
            : null,
          totalCost: money(totals.totalCost),
          totalAmount: money(totals.totalAmount),
          profitSnapshot: priced.some(item => item.costComplete === false) ? money(totals.netProfit) : null,
          documentUrl: body.documentUrl ?? null,
          // The client can never set the lifecycle state on create:
          // every order starts as `processing`.
          status: 'processing',
        })
        .returning();
      const order = inserted[0];
      if (!order)
        throw new Error('Order insert returned no row');
      await tx.insert(orderItems).values(priced.map((item) => ({
        shopId: shopId,
        orderId: order.id,
        recipeId: item.recipeId,
        // Frozen here, while the catalog row is in hand: every later read
        // prefers this over the live name (N-107).
        recipeName: item.name,
        quantity: qty(item.quantity),
        costComplete: item.costComplete,
        unitCost: money(item.unitCost),
        unitPrice: money(item.unitPrice),
      })));
      return order;
    };
    return transaction ? write(transaction) : this.database.transaction(write);
  }
  async edit(
    order: Order,
    body: UpdateOrderInput,
    saved: { id: string; quantity: number }[],
    added: PricedOrderItem[],
    removedIds: string[],
    totals: OrderTotals,
    profitSnapshot: string | null,
  ) {
    const changed = await this.database.update(orders).set({
      customerName: body.customerName,
      destinationAddress: body.destinationAddress,
      orderDate: body.orderDate,
      deliveryDate: body.deliveryDate,
      deliveryFee: money(totals.deliveryFee),
      totalAmount: money(totals.totalAmount),
      totalCost: money(totals.totalCost),
      profitSnapshot,
    }).where(and(eq(orders.id, order.id), eq(orders.shopId, order.shopId),
      eq(orders.status, 'processing'), isNull(orders.deletedAt))).returning({ id: orders.id });
    if (!changed.length) throw conflict('Only processing orders can be edited.');

    const lineScope = and(eq(orderItems.orderId, order.id), eq(orderItems.shopId, order.shopId));
    if (removedIds.length) {
      await this.database.delete(orderItems).where(and(lineScope, inArray(orderItems.id, removedIds)));
    }
    for (const line of saved) {
      await this.database.update(orderItems).set({ quantity: qty(line.quantity) })
        .where(and(lineScope, eq(orderItems.id, line.id)));
    }
    if (added.length) {
      await this.database.insert(orderItems).values(added.map(item => ({
        shopId: order.shopId,
        orderId: order.id,
        recipeId: item.recipeId,
        recipeName: item.name,
        quantity: qty(item.quantity),
        costComplete: item.costComplete,
        unitCost: money(item.unitCost),
        unitPrice: money(item.unitPrice),
      })));
    }
  }
  async verify(shopId: string, id: string) {
    const [updated] = await this.database.update(orders)
      .set({ status: 'delivered' })
      .where(and(
        eq(orders.id, id),
        eq(orders.shopId, shopId),
        eq(orders.status, 'processing'),
        isNull(orders.deletedAt),
      ))
      .returning();
    return updated;
  }
  async undoDelivery(shopId: string, id: string) {
    const [updated] = await this.database.update(orders)
      .set({ status: 'processing' })
      .where(and(eq(orders.id, id), eq(orders.shopId, shopId), eq(orders.status, 'delivered'), isNull(orders.deletedAt)))
      .returning({ id: orders.id });
    if (!updated) throw conflict('Only a Delivered order can have its delivery undone.');
  }
  async cancel(shopId: string, id: string, transaction?: OrdersTransaction) {
    const write = async (tx: OrdersTransaction) => {
      const rows = await tx
        .select({ id: orders.id, status: orders.status })
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.shopId, shopId), isNull(orders.deletedAt)))
        .limit(1)
        .for('update');
      const order = rows[0];
      if (!order)
        throw notFound('Order not found');
      if (order.status === 'cancelled')
        return null;
      const updated = await tx
        .update(orders)
        .set({ status: 'cancelled' })
        .where(and(eq(orders.id, id), eq(orders.shopId, shopId)))
        .returning({ id: orders.id });
      if (!updated[0])
        throw notFound('Order not found');
      return order.status;
    };
    return transaction ? write(transaction) : this.database.transaction(write);
  }
}

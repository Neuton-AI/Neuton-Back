import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Database } from '../../db/client.js';
import { orders, orderItems, orderItemRecipeName, recipes, shops, mediaUploads, recipeIngredients, inventoryItems, generalPrices } from '../../db/schema/index.js';
import type { Order } from '../../db/schema/orders.js';
import { recipeIngredientUnitCost } from '../../lib/recipeCostQuery.js';
import { money, quantity as qty, toNumber } from '../../lib/money.js';
import { notFound } from '../../lib/errors.js';
import type { CreateOrderInput, ListOrdersInput, OrderDto, PricedOrderItem, OrderTotals } from './contracts.js';
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
  async pricingInputs(shopId: string, recipeIds: string[]) {
    const recipeRows = await this.database
      .select()
      .from(recipes)
      .where(and(eq(recipes.shopId, shopId), inArray(recipes.id, recipeIds)));
    const ingredientRows = await this.database
      .select({
        recipeId: recipeIngredients.recipeId,
        quantity: recipeIngredients.baseUnitAmount,
        averageUnitCost: recipeIngredientUnitCost,
      })
      .from(recipeIngredients)
      .leftJoin(inventoryItems, and(eq(inventoryItems.id, recipeIngredients.inventoryItemId), eq(inventoryItems.shopId, shopId)))
      .leftJoin(generalPrices, eq(generalPrices.id, recipeIngredients.generalPriceId))
      .where(eq(recipeIngredients.shopId, shopId));
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
      .select()
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
    const [order] = await this.database.select().from(orders)
      .where(and(eq(orders.id, id), eq(orders.shopId, shopId), isNull(orders.deletedAt))).limit(1);
    if (!order)
      throw notFound('Order not found');
    return order;
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
  async create(shopId: string, userId: string, body: CreateOrderInput, priced: PricedOrderItem[], totals: OrderTotals, transaction?: OrdersTransaction) {
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
          orderDate: body.orderDate ?? new Date(),
          destinationAddress: body.destinationAddress ?? null,
          deliveryDistanceKm: toNumber(body.deliveryDistanceKm).toFixed(2),
          deliveryFee: money(totals.deliveryFee),
          appliedProfitMargin: priced[0]?.appliedProfitMargin !== undefined
            ? priced[0].appliedProfitMargin.toFixed(2)
            : null,
          totalCost: money(totals.totalCost),
          totalAmount: money(totals.totalAmount),
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
        unitCost: money(item.unitCost),
        unitPrice: money(item.unitPrice),
      })));
      return order;
    };
    return transaction ? write(transaction) : this.database.transaction(write);
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

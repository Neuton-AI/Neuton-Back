import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { OrdersPersistence, mapOrder, type OrdersTransaction } from './orders.persistence.js';
import { OrdersAudit } from './orders.audit.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { money, toNumber } from '../../lib/money.js';
import { readOrderProfit } from '../../lib/orderProfit.js';
import { calculateOrderPricing, calculateOrderTotals, calculateUnitCost } from '../../lib/pricing.js';
import type { CreateOrderInput, ListOrdersInput, PricedOrderItem, CreateOrderOutput, ListOrdersOutput, OrderDetailOutput, OrderMutationOutput, UpdateOrderInput } from './contracts.js';
import { reviewOrder, type OrderReviewState } from './order-review.js';
import { summarizeOrderPayments } from './order-payment-summary.js';

function isDeliveryBeforeOrder(deliveryDate: string, orderDate: Date, timeZone: string): boolean {
  const options: Intl.DateTimeFormatOptions = {
    calendar: 'gregory', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  const parts = Object.fromEntries(formatter.formatToParts(orderDate).map(({ type, value }) => [type, value]));
  if (parts.era === 'BC') return false;
  const orderDay = Number(parts.year) * 10000 + Number(parts.month) * 100 + Number(parts.day);
  return Number(deliveryDate.replaceAll('-', '')) < orderDay;
}

export const ORDERS_COMMIT_EFFECTS = Symbol('ORDERS_COMMIT_EFFECTS');
export type AfterCommit = (effect: () => Promise<void>) => void;
@Injectable()
export class OrdersService {
  private transaction?: OrdersTransaction;
  constructor(
    @Inject(OrdersPersistence) readonly persistence: OrdersPersistence,
    @Inject(OrdersAudit) readonly audit: OrdersAudit,
    @Optional() @Inject(ORDERS_COMMIT_EFFECTS) private readonly deferEffect?: AfterCommit,
  ) {}
  /** The outer transaction owner must run registered effects only after commit. */
  inTransaction(transaction: OrdersTransaction, afterCommit: AfterCommit): OrdersService {
    const service = new OrdersService(new OrdersPersistence(transaction), this.audit, afterCommit);
    service.transaction = transaction;
    return service;
  }
  private async committed(effect: () => Promise<void>) {
    if (this.deferEffect)
      this.deferEffect(effect);
    else
      await effect();
  }
  async list(actor: ActorContext, query: ListOrdersInput): Promise<ListOrdersOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const { rows, total } = await this.persistence.list(actor.shop.id, query);
    const history = await this.persistence.paymentHistory(actor.shop.id, rows.map(order => order.id));
    return {
      orders: rows.map(order => ({
        ...mapOrder(order),
        netProfit: readOrderProfit(order),
        paymentSummary: summarizeOrderPayments(order.status, order.totalAmount, history.get(order.id) ?? []),
      })),
      total,
    };
  }
  async detail(actor: ActorContext, id: string): Promise<OrderDetailOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const order = await this.persistence.find(actor.shop.id, id);
    const [{ items, sources }, history] = await Promise.all([
      this.persistence.detailLines(actor.shop.id, id),
      this.persistence.paymentHistory(actor.shop.id, [id]),
    ]);
    const payments = history.get(id) ?? [];
    return {
      order: {
        ...mapOrder(order),
        items: items.map(item => ({
          id: item.id,
          recipeId: item.recipeId,
          name: item.name,
          quantity: item.quantity,
          costComplete: item.costComplete ?? null,
          unitCost: item.unitCost,
          unitPrice: item.unitPrice,
        })),
        sources,
        netProfit: readOrderProfit(order),
        paymentSummary: summarizeOrderPayments(order.status, order.totalAmount, payments),
        paymentHistory: payments.map(payment => ({
          id: payment.id,
          kind: payment.kind,
          amount: payment.amount,
          occurredAt: payment.occurredAt.toISOString(),
          recordedAt: payment.recordedAt.toISOString(),
          recordedByUserId: payment.recordedByUserId,
        })),
      },
    };
  }
  async create(actor: ActorContext, body: CreateOrderInput): Promise<CreateOrderOutput> {
    requireActorRole(actor, ['owner', 'admin']);
    if (!this.transaction) {
      const effects: Array<() => Promise<void>> = [];
      let attempts = 0;
      const result = await this.persistence.runSerializable(tx => {
        effects.length = 0;
        attempts++;
        if (attempts > 1) {
          actor.log.info({ event: 'order_create_retry', attempt: attempts }, 'retrying rolled-back order creation');
        }
        return this.inTransaction(tx, effect => effects.push(effect)).create(actor, body);
      });
      for (const effect of effects) await effect();
      return result;
    }
    const shop = await this.persistence.currentShop(actor.shop.id);
    const orderDate = body.orderDate ?? new Date();
    if (body.deliveryDate && isDeliveryBeforeOrder(body.deliveryDate, orderDate, shop.timezone)) {
      throw badRequest('Delivery date must be on or after the order date.');
    }
    const priced = await this.priceNewLines(actor, shop, body.items, body.confirmedUnavailableRecipeIds);
    const deliveryFee = body.deliveryFee ?? toNumber(shop.deliveryBaseFee);
    const totals = calculateOrderTotals({ items: priced, deliveryFee });
    if (totals.totalAmount > 99_999_999.99 || totals.totalCost > 99_999_999.99) {
      throw badRequest('Order total exceeds the supported amount.');
    }
    const created = await this.persistence.create(shop.id, actor.user.id, { ...body, orderDate }, priced, totals, this.transaction);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'ORDER_CREATED',
        resourceId: created.id,
        ipAddress: actor.ipAddress,
        metadata: { totalAmount: totals.totalAmount, items: priced.length },
      });
      actor.log.info({ event: 'order_created', orderId: created.id }, 'order created');
    });
    return { order: mapOrder(created), totals };
  }
  private async priceNewLines(
    actor: ActorContext,
    shop: Awaited<ReturnType<OrdersPersistence['currentShop']>>,
    items: CreateOrderInput['items'],
    confirmedUnavailableRecipeIds?: string[],
    retainedCount = 0,
  ): Promise<PricedOrderItem[]> {
    if (!items.length) return [];
    const { recipeRows, ingredientRows } = await this.persistence.pricingInputs(shop.id, items.map(item => item.recipeId));
    const states: OrderReviewState[] = [];
    const priced: PricedOrderItem[] = [];
    for (const item of items) {
      const recipe = recipeRows.find(row => row.id === item.recipeId);
      if (!recipe) {
        states.push({ recipeId: item.recipeId, reason: 'NOT_FOUND' });
        continue;
      }
      if (!recipe.isActive || recipe.status !== 'verified') {
        states.push({ recipeId: item.recipeId, reason: recipe.isActive ? 'UNVERIFIED' : 'INACTIVE' });
        continue;
      }
      const breakdown = calculateUnitCost({
        ingredients: ingredientRows.filter(row => row.recipeId === recipe.id).map(row => ({ quantity: row.quantity, averageUnitCost: row.averageUnitCost })),
        prepTimeMinutes: recipe.prepTimeMinutes, hourlyLaborCost: shop.hourlyLaborCost, yieldQuantity: recipe.yieldQuantity,
      });
      const { orderPricing, orderPricingError } = calculateOrderPricing(breakdown, shop.targetProfitMargin, recipe.targetMarginPct);
      if (!orderPricing) {
        throw new AppError(400, 'INVALID_RECIPE_YIELD', orderPricingError?.message ?? 'Recipe pricing is unavailable.');
      }
      const retailPrice = Number(orderPricing.unitPrice);
      const knownUnitCost = Number(orderPricing.unitCost);
      if (!Number.isFinite(retailPrice) || retailPrice < 0 || retailPrice > 99_999_999.99 ||
        !Number.isFinite(knownUnitCost) || knownUnitCost < 0 || Number(money(knownUnitCost)) > 99_999_999.99) {
        throw new AppError(400, 'ORDER_PRICING_UNAVAILABLE', 'Recipe pricing is outside the supported amount range.');
      }
      states.push({ recipeId: recipe.id, reason: null, name: recipe.name, unitPrice: orderPricing.unitPrice, costComplete: orderPricing.costComplete });
      priced.push({ recipeId: recipe.id, name: recipe.name, quantity: item.quantity, unitCost: knownUnitCost,
        unitPrice: item.unitPrice ?? retailPrice, costComplete: orderPricing.costComplete,
        appliedProfitMargin: toNumber(recipe.targetMarginPct ?? shop.targetProfitMargin) });
    }
    try {
      reviewOrder({ items, confirmedUnavailableRecipeIds }, states, retainedCount);
    } catch (error) {
      if (error instanceof AppError) {
        actor.log.info({ event: 'order_review_rejected', code: error.code }, 'order requires updated review');
      }
      throw error;
    }
    return priced;
  }

  async edit(actor: ActorContext, id: string, body: UpdateOrderInput): Promise<OrderDetailOutput> {
    requireActorRole(actor, ['owner', 'admin']);
    const order = await this.persistence.find(actor.shop.id, id);
    if (order.status !== 'processing') throw conflict('Only processing orders can be edited.');
    const shop = await this.persistence.currentShop(actor.shop.id);
    const deliveryDate = body.deliveryDate === undefined ? order.deliveryDate : body.deliveryDate;
    if ((body.deliveryDate !== undefined || body.orderDate) && deliveryDate &&
        isDeliveryBeforeOrder(deliveryDate, body.orderDate ?? order.orderDate, shop.timezone)) {
      throw badRequest('Delivery date must be on or after the order date.');
    }

    const { items } = await this.persistence.detailLines(shop.id, id);
    const byId = new Map(items.map(line => [line.id, line]));
    const retained = body.items.filter(line => 'lineId' in line).map(line => {
      const item = byId.get(line.lineId);
      if (!item) throw badRequest('A saved line does not belong to this order.');
      return { ...item, quantity: line.quantity };
    });
    const newLines = body.items.filter(line => 'recipeId' in line);
    const added = await this.priceNewLines(actor, shop, newLines, body.confirmedUnavailableRecipeIds, retained.length);
    const retainedIds = new Set(retained.map(line => line.id));
    const removedIds = items.filter(line => !retainedIds.has(line.id)).map(line => line.id);
    const changed = retained.filter(line => line.quantity !== Number(byId.get(line.id)?.quantity));
    const linesChanged = changed.length > 0 || removedIds.length > 0 || added.length > 0;
    const totals = calculateOrderTotals({
      deliveryFee: body.deliveryFee,
      items: [...retained.map(line => ({
        quantity: line.quantity,
        unitCost: toNumber(line.unitCost),
        unitPrice: toNumber(line.unitPrice),
        costComplete: line.costComplete,
      })), ...added],
    });
    let profitSnapshot = order.profitSnapshot;
    if (linesChanged) {
      profitSnapshot = [...retained, ...added].some(line => line.costComplete === false) ? money(totals.netProfit) : null;
    } else {
      // Preserve historical accounting and any sub-cent costing on metadata-only edits.
      totals.totalCost = toNumber(order.totalCost);
      totals.totalAmount = Number(money(toNumber(order.totalAmount) - toNumber(order.deliveryFee) + body.deliveryFee));
    }
    if (totals.totalAmount < 0 || totals.totalAmount > 99_999_999.99 || totals.totalCost > 99_999_999.99) {
      throw badRequest('Order total exceeds the supported amount.');
    }
    await this.persistence.edit(order, body, changed, added, removedIds, totals, profitSnapshot);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: shop.id,
        userId: actor.user.id,
        eventType: 'ORDER_UPDATED',
        resourceId: id,
        ipAddress: actor.ipAddress,
        metadata: { totalAmount: totals.totalAmount, items: retained.length + added.length },
      });
    });
    return this.detail(actor, id);
  }

  async verify(actor: ActorContext, id: string): Promise<OrderMutationOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const order = await this.persistence.find(actor.shop.id, id);
    if (order.status !== 'processing')
      throw badRequest(`Order is already ${order.status}`);
    const next = await this.persistence.verify(actor.shop.id, id);
    if (!next)
      throw conflict('Order changed during verification; reload before retrying');
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'ORDER_DELIVERED',
        resourceId: id,
        ipAddress: actor.ipAddress,
        metadata: { from: 'processing', to: 'delivered' },
      });
      actor.log.info({ event: 'order_delivered', orderId: id }, 'order delivered');
    });
    return { order: mapOrder(next) };
  }
  async undoDelivery(actor: ActorContext, id: string): Promise<OrderDetailOutput> {
    requireActorRole(actor, ['owner', 'admin']);
    if (!this.transaction) throw new Error('Undo delivery requires a transaction');
    await this.persistence.undoDelivery(actor.shop.id, id);
    await recordAudit({
      shopId: actor.shop.id,
      userId: actor.user.id,
      eventType: 'ORDER_DELIVERY_UNDONE',
      resourceId: id,
      ipAddress: actor.ipAddress,
      metadata: { from: 'delivered', to: 'processing' },
    }, this.transaction);
    return this.detail(actor, id);
  }
  async cancel(actor: ActorContext, id: string): Promise<{ ok: true }> {
    requireActorRole(actor, ['owner', 'admin']);
    const previousStatus = await this.persistence.cancel(actor.shop.id, id);
    if (previousStatus) {
      await this.committed(async () => {
        await this.audit.record(actor, {
          shopId: actor.shop.id,
          userId: actor.user.id,
          eventType: 'ORDER_CANCELLED',
          resourceId: id,
          ipAddress: actor.ipAddress,
          metadata: { from: previousStatus, to: 'cancelled' },
        });
        actor.log.info({ event: 'order_cancelled', orderId: id }, 'order cancelled');
      });
    }
    return { ok: true };
  }
}

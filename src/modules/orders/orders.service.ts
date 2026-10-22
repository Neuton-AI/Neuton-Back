import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ActorContext } from '../identity/contracts.js';
import { requireActorRole } from '../identity/authorization.js';
import { OrdersPersistence, mapOrder, type OrdersTransaction } from './orders.persistence.js';
import { OrdersAudit } from './orders.audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { toNumber } from '../../lib/money.js';
import { calculateDeliveryFee, calculateOrderTotals, calculateRetailPrice, calculateUnitCost } from '../../lib/pricing.js';
import type { CreateOrderInput, QuoteOrderInput, ListOrdersInput, PricedOrderItem, QuoteOrderOutput, CreateOrderOutput, ListOrdersOutput, OrderDetailOutput, OrderMutationOutput } from './contracts.js';
export const ORDERS_COMMIT_EFFECTS = Symbol('ORDERS_COMMIT_EFFECTS');
export type AfterCommit = (effect: () => Promise<void>) => void;
@Injectable()
export class OrdersService {
  constructor(
    @Inject(OrdersPersistence) readonly persistence: OrdersPersistence,
    @Inject(OrdersAudit) readonly audit: OrdersAudit,
    @Optional() @Inject(ORDERS_COMMIT_EFFECTS) private readonly deferEffect?: AfterCommit,
  ) {}
  /** The outer transaction owner must run registered effects only after commit. */
  inTransaction(transaction: OrdersTransaction, afterCommit: AfterCommit): OrdersService {
    return new OrdersService(new OrdersPersistence(transaction), this.audit, afterCommit);
  }
  private async committed(effect: () => Promise<void>) {
    if (this.deferEffect)
      this.deferEffect(effect);
    else
      await effect();
  }
  private async price(actor: ActorContext, items: QuoteOrderInput['items']): Promise<PricedOrderItem[]> {
    const { shop } = actor;
    const { recipeRows, ingredientRows } = await this.persistence.pricingInputs(shop.id, [...new Set(items.map(item => item.recipeId))]);
    const hourlyLaborCost = shop.hourlyLaborCost;
    const shopMargin = shop.targetProfitMargin;
    const byRecipe = new Map<string, typeof ingredientRows>();
    for (const row of ingredientRows) {
      const list = byRecipe.get(row.recipeId) ?? [];
      list.push(row);
      byRecipe.set(row.recipeId, list);
    }
    return items.map((item) => {
      const recipe = recipeRows.find((row) => row.id === item.recipeId);
      if (!recipe)
        throw notFound(`Recipe ${item.recipeId} not found`);
      const breakdown = calculateUnitCost({
        ingredients: (byRecipe.get(recipe.id) ?? []).map((row) => ({
          quantity: row.quantity,
          averageUnitCost: row.averageUnitCost,
        })),
        prepTimeMinutes: recipe.prepTimeMinutes,
        hourlyLaborCost,
        yieldQuantity: recipe.yieldQuantity,
      });
      if (!breakdown.costComplete)
        throw badRequest(`Recipe ${recipe.name} has incomplete ingredient costs`);
      const { retailPrice, appliedMarginPercent } = calculateRetailPrice(breakdown.unitCost, shopMargin, recipe.targetMarginPct);
      return {
        recipeId: recipe.id,
        name: recipe.name,
        quantity: item.quantity,
        unitCost: breakdown.unitCost,
        unitPrice: item.unitPrice ?? retailPrice,
        appliedProfitMargin: appliedMarginPercent,
        retailPrice,
      };
    });
  }
  async list(actor: ActorContext, query: ListOrdersInput): Promise<ListOrdersOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const { rows, total } = await this.persistence.list(actor.shop.id, query);
    return {
      orders: rows.map(order => ({
        ...mapOrder(order),
        netProfit: toNumber(order.totalAmount) - toNumber(order.deliveryFee) - toNumber(order.totalCost),
      })),
      total,
    };
  }
  async detail(actor: ActorContext, id: string): Promise<OrderDetailOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const order = await this.persistence.find(actor.shop.id, id);
    const { items, sources } = await this.persistence.detailLines(actor.shop.id, id);
    return {
      order: {
        ...mapOrder(order),
        items: items.map(item => ({
          id: item.id,
          recipeId: item.recipeId,
          name: item.name,
          quantity: item.quantity,
          unitCost: item.unitCost,
          unitPrice: item.unitPrice,
        })),
        sources,
        netProfit: toNumber(order.totalAmount) - toNumber(order.deliveryFee) - toNumber(order.totalCost),
      },
    };
  }
  async quote(actor: ActorContext, body: QuoteOrderInput): Promise<QuoteOrderOutput> {
    requireActorRole(actor, ['owner', 'admin', 'member']);
    const items = await this.price(actor, body.items);
    const deliveryFee = calculateDeliveryFee(body.deliveryDistanceKm, actor.shop.deliveryBaseFee, actor.shop.deliveryRatePerKm);
    const totals = calculateOrderTotals({ items, deliveryFee });
    return {
      items,
      deliveryDistanceKm: body.deliveryDistanceKm,
      baseFee: toNumber(actor.shop.deliveryBaseFee),
      ratePerKm: toNumber(actor.shop.deliveryRatePerKm),
      ...totals,
    };
  }
  async create(actor: ActorContext, body: CreateOrderInput): Promise<CreateOrderOutput> {
    requireActorRole(actor, ['owner', 'admin']);
    const quote = await this.quote(actor, body);
    const totals = calculateOrderTotals({ items: quote.items, deliveryFee: quote.deliveryFee });
    const created = await this.persistence.create(actor.shop.id, actor.user.id, body, quote.items, totals);
    await this.committed(async () => {
      await this.audit.record(actor, {
        shopId: actor.shop.id,
        userId: actor.user.id,
        eventType: 'ORDER_CREATED',
        resourceId: created.id,
        ipAddress: actor.ipAddress,
        metadata: { totalAmount: totals.totalAmount, items: quote.items.length },
      });
      actor.log.info({ event: 'order_created', orderId: created.id }, 'order created');
    });
    return { order: mapOrder(created), totals };
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

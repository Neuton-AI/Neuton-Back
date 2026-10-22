import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { db, type Database } from '../db/client.js';
import { currentShop, currentUser, currentRole } from '../plugins/auth.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import { OrdersService, type AfterCommit } from '../modules/orders/orders.service.js';
import { OrdersPersistence, type OrdersTransaction } from '../modules/orders/orders.persistence.js';
import { OrdersAudit } from '../modules/orders/orders.audit.js';
import { createOrderSchema, listOrdersSchema, orderIdSchema, quoteOrderSchema } from '../modules/orders/contracts.js';

/** Per-request database seam retained for scripted tests and sync transactions. */
export interface OrdersDeps {
  db: Database;
  transaction?: { db: OrdersTransaction; afterCommit: AfterCommit };
}

declare module 'fastify' {
  interface FastifyRequest {
    ordersDeps?: OrdersDeps;
  }
}

export const defaultOrdersDeps: OrdersDeps = { db };

function actor(request: FastifyRequest): ActorContext {
  return {
    shop: currentShop(request),
    user: currentUser(request),
    role: currentRole(request),
    requestId: request.id,
    traceId: request.traceId ?? request.id,
    ipAddress: request.ip,
    log: request.log,
  };
}

function service(request: FastifyRequest): OrdersService {
  const deps = request.ordersDeps ?? defaultOrdersDeps;
  const orders = new OrdersService(new OrdersPersistence(deps.db), new OrdersAudit());
  return deps.transaction
    ? orders.inTransaction(deps.transaction.db, deps.transaction.afterCommit)
    : orders;
}

/** Fastify remains the production transport until the phase-five cutover. */
export const orderRoutes: FastifyPluginAsync = async (app) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [app.authenticate, app.resolveShop, app.requireRole(['owner', 'admin'])],
  };

  app.get('/orders', guards, async (request) =>
    service(request).list(actor(request), listOrdersSchema.parse(request.query)));

  app.get('/orders/:id', guards, async (request) =>
    service(request).detail(actor(request), orderIdSchema.parse(request.params).id));

  app.post('/orders/quote', guards, async (request) =>
    service(request).quote(actor(request), quoteOrderSchema.parse(request.body)));

  app.post('/orders', mutationGuards, async (request, reply) => {
    const result = await service(request).create(actor(request), createOrderSchema.parse(request.body));
    return reply.code(201).send(result);
  });

  app.post('/orders/:id/verify', guards, async (request) =>
    service(request).verify(actor(request), orderIdSchema.parse(request.params).id));

  app.delete('/orders/:id', mutationGuards, async (request) =>
    service(request).cancel(actor(request), orderIdSchema.parse(request.params).id));
};

import { z } from 'zod';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { currentShop, currentUser, currentRole } from '../plugins/auth.js';
import { defaultReceiptsDeps } from './receipts.js';
import type { ActorContext } from '../modules/identity/contracts.js';
import {
  CatalogService,
  type CatalogAfterCommit,
} from '../modules/catalog/catalog.service.js';
import {
  CatalogPersistence,
  type CatalogTransaction,
} from '../modules/catalog/catalog.persistence.js';
import {
  createCategorySchema,
  inventoryQuerySchema,
  recipeQuerySchema,
  recipeIdSchema,
  recipeSchema,
  recipePatchSchema,
  verifyRecipeSchema,
  inventorySchema,
  inventoryPatchSchema,
  barcodePriceSchema,
} from '../modules/catalog/contracts.js';
import { manualProductSchema } from '../lib/manualProduct.js';
import { searchProduct } from '../lib/supermarket/prices.js';
import { inventoryAdjustmentSchema } from '../lib/inventoryAdjustments.js';
declare module 'fastify' {
  interface FastifyRequest {
    catalogTransaction?: {
      db: CatalogTransaction;
      afterCommit: CatalogAfterCommit;
    };
  }
}

function catalogActor(request: FastifyRequest): ActorContext {
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

function catalogService(
  request: FastifyRequest,
  search?: typeof searchProduct,
): CatalogService {
  const service = new CatalogService(
    new CatalogPersistence((request.receiptsDeps ?? defaultReceiptsDeps).db),
    undefined,
    undefined,
    search,
  );
  return request.catalogTransaction
    ? service.inTransaction(
        request.catalogTransaction.db,
        request.catalogTransaction.afterCommit,
      )
    : service;
}

export const catalogRoutes: FastifyPluginAsync<{
  searchProduct?: typeof searchProduct;
}> = async (app, options) => {
  const guards = { preHandler: [app.authenticate, app.resolveShop] };
  const mutationGuards = {
    preHandler: [
      app.authenticate,
      app.resolveShop,
      app.requireRole(['owner', 'admin']),
    ],
  };

  app.get('/categories', guards, async (request) =>
    catalogService(request).categories(catalogActor(request)),
  );

  app.post('/categories', mutationGuards, async (request, reply) => {
    const result = await catalogService(request).createCategory(
      catalogActor(request),
      createCategorySchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });

  app.get('/recipes', guards, async (request) =>
    catalogService(request).recipes(
      catalogActor(request),
      recipeQuerySchema.parse(request.query),
    ),
  );

  app.post('/recipes', mutationGuards, async (request, reply) => {
    const result = await catalogService(request).createRecipe(
      catalogActor(request),
      recipeSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });

  app.get('/recipes/:id', guards, async (request) =>
    catalogService(request).recipe(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
    ),
  );

  app.patch('/recipes/:id', mutationGuards, async (request) =>
    catalogService(request).editRecipe(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
      recipePatchSchema.parse(request.body),
    ),
  );
  /** Create shop-owned pricing without recording a purchase or changing the saved recipe. */
  app.post(
    '/recipes/:id/manual-product',
    mutationGuards,
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await catalogService(request).manualProduct(
            catalogActor(request),
            recipeIdSchema.parse(request.params).id,
            manualProductSchema.parse(request.body),
          ),
        ),
  );

  /** Price a draft ingredient by exact barcode without changing the saved recipe. */
  app.post('/recipes/:id/barcode-price', mutationGuards, async (request) =>
    catalogService(request, options.searchProduct).barcodePrice(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
      barcodePriceSchema.parse(request.body),
    ),
  );

  app.delete('/recipes/:id', mutationGuards, async (request) =>
    catalogService(request).deleteRecipe(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
    ),
  );

  app.get('/inventory', guards, async (request) =>
    catalogService(request).inventory(
      catalogActor(request),
      inventoryQuerySchema.parse(request.query),
    ),
  );

  app.post('/inventory', mutationGuards, async (request, reply) =>
    reply
      .code(201)
      .send(
        await catalogService(request).createInventory(
          catalogActor(request),
          inventorySchema.parse(request.body),
        ),
      ),
  );

  app.patch('/inventory/:id', mutationGuards, async (request) =>
    catalogService(request).editInventory(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
      inventoryPatchSchema.parse(request.body),
    ),
  );

  app.delete('/inventory/:id', mutationGuards, async (request) =>
    catalogService(request).deactivateInventory(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
    ),
  );

  app.post('/recipes/:id/verify', mutationGuards, async (request) =>
    catalogService(request).verifyRecipe(
      catalogActor(request),
      recipeIdSchema.parse(request.params).id,
      verifyRecipeSchema.parse(request.body),
    ),
  );
  /** Fully costed recipes available to the order item picker, including out-of-stock recipes. */
  app.get('/recipes/orderable', guards, async (request) =>
    catalogService(request).orderable(catalogActor(request)),
  );

  /** Bulk stock adjustment used by the Inventory grid after manual counts. */
  app.post('/inventory/adjust', mutationGuards, async (request) =>
    catalogService(request).adjustInventory(
      catalogActor(request),
      inventoryAdjustmentSchema.parse(request.body),
      z.string().uuid().optional().parse(request.headers['idempotency-key']),
    ),
  );
};

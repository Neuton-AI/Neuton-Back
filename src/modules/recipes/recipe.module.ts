import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { searchProduct } from '../../lib/supermarket/product-search.js';
import { DomainAudit } from '../../lib/domainAudit.js';
import { RECIPE_DATABASE, RecipePersistence } from './recipe.persistence.js';
import { RecipeService, RECIPE_SEARCH } from './recipe.service.js';
import { RecipeController } from './recipe.controller.js';
@Module({
  imports: [IdentityModule, SyncModule],
  controllers: [RecipeController],
  providers: [
    { provide: RECIPE_DATABASE, useValue: db },
    { provide: RECIPE_SEARCH, useValue: searchProduct },
    RecipePersistence, RecipeService, DomainAudit,
  ],
  exports: [RecipeService],
})
export class RecipeModule {}

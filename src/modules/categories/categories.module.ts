import { Module } from '@nestjs/common';
import { db } from '../../db/client.js';
import { IdentityModule } from '../identity/identity.module.js';


import { CATEGORIES_DATABASE, CategoriesPersistence } from './categories.persistence.js';
import { CategoriesService } from './categories.service.js';
import { CategoriesController } from './categories.controller.js';
@Module({
  imports: [IdentityModule],
  controllers: [CategoriesController],
  providers: [
    { provide: CATEGORIES_DATABASE, useValue: db },
    
    CategoriesPersistence, CategoriesService,
  ],
  exports: [CategoriesService],
})
export class CategoriesModule {}
